"""Baixa e cruza os dados (TSE + IBGE) e gera web/data/municipios.geojson.

Uso: uv run scripts/build_data.py [--ano 2026] [--ano-pop 2026]

Fontes:
- TSE, dados abertos: votacao_candidato_munzona_<ano>.zip (arquivo *_BR.csv = Presidente)
- IBGE, API de malhas v3: contorno dos municípios
- IBGE, SIDRA tabela 6579: população residente estimada
- betafcc/Municipios-Brasileiros-TSE: de-para código TSE -> código IBGE
"""

import argparse
import csv
import gzip
import io
import json
import math
import sys
import unicodedata
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "web" / "data" / "municipios.geojson"

URL_TSE = "https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_candidato_munzona/votacao_candidato_munzona_{ano}.zip"
URL_MALHA = "https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR?formato=application/vnd.geo+json&qualidade=minima&intrarregiao=municipio"
URL_POP = "https://apisidra.ibge.gov.br/values/t/6579/n6/all/v/9324/p/{ano}"
URL_LOCALIDADES = "https://servicodados.ibge.gov.br/api/v1/localidades/municipios?view=nivelado"
URL_DEPARA = "https://raw.githubusercontent.com/betafcc/Municipios-Brasileiros-TSE/master/municipios_brasileiros_tse.csv"

NR_LULA = "13"


def baixar(url: str, nome: str) -> Path:
    destino = RAW / nome
    if destino.exists() and destino.stat().st_size > 0:
        return destino
    print(f"baixando {url}")
    RAW.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "demographic-election-map"})
    with urllib.request.urlopen(req, timeout=600) as resp, open(destino.with_suffix(".part"), "wb") as f:
        while bloco := resp.read(1 << 20):
            f.write(bloco)
    part = destino.with_suffix(".part")
    dados = part.read_bytes()
    if dados[:2] == b"\x1f\x8b":  # a API do IBGE responde gzip mesmo sem Accept-Encoding
        part.write_bytes(gzip.decompress(dados))
    part.rename(destino)
    return destino


def normalizar(nome: str) -> str:
    nome = unicodedata.normalize("NFKD", nome).encode("ascii", "ignore").decode()
    return "".join(ch for ch in nome.upper() if ch.isalnum())


def ler_votos(ano: int) -> tuple[dict, dict]:
    """Votos válidos do 2º turno por código TSE de município: {cd_tse: {"lula": n, "outro": n}}."""
    zpath = baixar(URL_TSE.format(ano=ano), f"votacao_candidato_munzona_{ano}.zip")
    votos = defaultdict(lambda: {"lula": 0, "outro": 0})
    info = {"outro": None, "uf_nome": {}}
    with zipfile.ZipFile(zpath) as z:
        with z.open(f"votacao_candidato_munzona_{ano}_BR.csv") as raw:
            for row in csv.DictReader(io.TextIOWrapper(raw, encoding="latin1"), delimiter=";"):
                if row["NR_TURNO"] != "2" or row["DS_CARGO"] != "Presidente" or row["SG_UF"] == "ZZ":
                    continue
                qt = int(row["QT_VOTOS_NOMINAIS_VALIDOS"])
                cd = row["CD_MUNICIPIO"]
                if row["NR_CANDIDATO"] == NR_LULA:
                    votos[cd]["lula"] += qt
                else:
                    votos[cd]["outro"] += qt
                    info["outro"] = row["NM_URNA_CANDIDATO"]
                info["uf_nome"][cd] = (row["SG_UF"], row["NM_MUNICIPIO"])
    if not votos:
        sys.exit(f"Nenhum voto de 2º turno presidencial encontrado para {ano}.")
    return votos, info


def ler_populacao(ano: int) -> dict:
    path = baixar(URL_POP.format(ano=ano), f"populacao_{ano}.json")
    linhas = json.loads(path.read_text())[1:]  # primeira linha é o cabeçalho
    return {l["D1C"]: int(l["V"]) for l in linhas if l["V"].isdigit()}


def area_km2(geom: dict) -> float:
    """Área via projeção cilíndrica equivalente de Lambert (preserva área)."""
    r = 6371.0088
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    total = 0.0
    for poly in polys:
        for i, anel in enumerate(poly):
            s = 0.0
            for (x1, y1), (x2, y2) in zip(anel, anel[1:] + anel[:1]):
                s += math.radians(x1) * math.sin(math.radians(y2)) - math.radians(x2) * math.sin(math.radians(y1))
            a = abs(s) / 2 * r * r
            total += a if i == 0 else -a  # anéis seguintes são buracos
    return total


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ano", type=int, default=2026, help="ano da eleição")
    ap.add_argument("--ano-pop", type=int, default=2026, help="ano da estimativa de população do IBGE")
    args = ap.parse_args()

    votos, info = ler_votos(args.ano)
    pop = ler_populacao(args.ano_pop)
    malha = json.loads(baixar(URL_MALHA, "malha_municipios.json").read_text())
    localidades = json.loads(baixar(URL_LOCALIDADES, "localidades.json").read_text())

    # nome/UF oficiais do IBGE
    ibge = {str(m["municipio-id"]): (m["UF-sigla"], m["municipio-nome"]) for m in localidades}

    # de-para TSE -> IBGE; quem não estiver na tabela é casado por UF + nome normalizado
    with open(baixar(URL_DEPARA, "tse_ibge.csv"), encoding="utf-8") as f:
        tse_para_ibge = {r["codigo_tse"].lstrip("0"): r["codigo_ibge"] for r in csv.DictReader(f)}
    por_nome = {(uf, normalizar(nome)): cod for cod, (uf, nome) in ibge.items()}

    votos_ibge = defaultdict(lambda: {"lula": 0, "outro": 0})
    sem_par = []
    for cd_tse, v in votos.items():
        cod = tse_para_ibge.get(cd_tse.lstrip("0"))
        if cod is None:
            uf, nome = info["uf_nome"][cd_tse]
            cod = por_nome.get((uf, normalizar(nome)))
        if cod is None:
            sem_par.append((cd_tse, *info["uf_nome"][cd_tse], v))
            continue
        votos_ibge[cod]["lula"] += v["lula"]
        votos_ibge[cod]["outro"] += v["outro"]

    feats, sem_voto, sem_pop = [], [], []
    for ft in malha["features"]:
        cod = ft["properties"]["codarea"]
        uf, nome = ibge.get(cod, ("?", cod))
        v = votos_ibge.get(cod)
        p = pop.get(cod)
        if v is None:
            sem_voto.append(f"{nome}/{uf}")
        if p is None:
            sem_pop.append(f"{nome}/{uf}")
        validos = (v["lula"] + v["outro"]) if v else 0
        feats.append({
            "type": "Feature",
            "geometry": ft["geometry"],
            "properties": {
                "c": cod,
                "n": nome,
                "uf": uf,
                "p": p or 0,
                "a": round(area_km2(ft["geometry"]), 1),
                "l": v["lula"] if v else 0,
                "o": v["outro"] if v else 0,
                "pl": round(100 * v["lula"] / validos, 2) if validos else None,
            },
        })

    tot_l = sum(f["properties"]["l"] for f in feats)
    tot_o = sum(f["properties"]["o"] for f in feats)
    saida = {
        "type": "FeatureCollection",
        "metadata": {
            "ano": args.ano,
            "ano_pop": args.ano_pop,
            "outro": info["outro"].title(),
            "votos_lula": tot_l,
            "votos_outro": tot_o,
        },
        "features": feats,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(saida, ensure_ascii=False, separators=(",", ":")))

    print(f"\n{len(feats)} municípios -> {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1e6:.1f} MB)")
    print(f"Lula {tot_l:,} x {info['outro']} {tot_o:,} (votos válidos no Brasil, sem exterior)")
    if sem_par:
        print(f"AVISO: {len(sem_par)} códigos TSE sem correspondência no IBGE: {sem_par}")
    if sem_voto:
        print(f"AVISO: {len(sem_voto)} municípios da malha sem votos: {sem_voto}")
    if sem_pop:
        print(f"AVISO: {len(sem_pop)} municípios sem população: {sem_pop}")


if __name__ == "__main__":
    main()

"""Gera as grades do pôster (relevo suave) a partir de web/data/municipios.geojson.

Uso: uv run scripts/build_poster.py [--largura 2048] [--sigma-km 20] [--sigma-cor-km 20]

A população de cada município é espalhada uniformemente pelo seu território e
suavizada com um filtro gaussiano (convolução normalizada pela área de terra,
para o litoral não "afundar"). A % de votos é suavizada do mesmo jeito,
ponderada pelos votos válidos.

Saídas em web/poster/:
- relevo.png: densidade suavizada, log1p normalizado em 16 bits (R = byte alto, G = byte baixo)
- votos.png:  % Lula suavizado * 2.5 em 8 bits (0..250); 255 = mar (a terra se estende 6 px)
- meta.json:  dimensões e parâmetros para decodificar
"""

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt, gaussian_filter

ROOT = Path(__file__).resolve().parent.parent
ENTRADA = ROOT / "web" / "data" / "municipios.geojson"
SAIDA = ROOT / "web" / "poster"

KM_POR_GRAU = 111.32
MARGEM = 0.5  # graus


def aneis_externos(geom: dict):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    return [poly[0] for poly in polys]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--largura", type=int, default=2048, help="largura da grade de cor (px); o relevo usa metade")
    ap.add_argument("--sigma-km", type=float, default=20, help="suavização do relevo (km)")
    ap.add_argument("--sigma-cor-km", type=float, default=20, help="suavização da cor (km)")
    args = ap.parse_args()

    dados = json.loads(ENTRADA.read_text())
    feats = dados["features"]

    lons = [x for f in feats for anel in aneis_externos(f["geometry"]) for x, _ in anel]
    lats = [y for f in feats for anel in aneis_externos(f["geometry"]) for _, y in anel]
    lon0, lon1 = min(lons) - MARGEM, max(lons) + MARGEM
    lat0, lat1 = min(lats) - MARGEM, max(lats) + MARGEM

    # projeção equiretangular com paralelo padrão no centro do país
    kx = math.cos(math.radians((lat0 + lat1) / 2))
    W = args.largura
    escala = W / ((lon1 - lon0) * kx)  # px por grau (latitude)
    H = math.ceil((lat1 - lat0) * escala)
    km_px = KM_POR_GRAU / escala

    def px(lon, lat):
        return ((lon - lon0) * kx * escala, (lat1 - lat) * escala)

    # raster de rótulos: cada pixel recebe o índice (1..n) do município; maiores primeiro
    ordem = sorted(range(len(feats)), key=lambda i: -feats[i]["properties"]["a"])
    rotulos_img = Image.new("I", (W, H), 0)
    desenho = ImageDraw.Draw(rotulos_img)
    for i in ordem:
        for anel in aneis_externos(feats[i]["geometry"]):
            desenho.polygon([px(x, y) for x, y in anel], fill=i + 1)
    rotulos = np.asarray(rotulos_img, dtype=np.int32)

    n = len(feats)
    pop = np.array([0] + [f["properties"]["p"] for f in feats], dtype=np.float64)
    lula = np.array([0] + [f["properties"]["l"] for f in feats], dtype=np.float64)
    validos = lula + np.array([0] + [f["properties"]["o"] for f in feats], dtype=np.float64)
    contagem = np.bincount(rotulos.ravel(), minlength=n + 1).astype(np.float64)

    def espalhar(total):
        por_px = np.divide(total, contagem, out=np.zeros_like(total), where=contagem > 0)
        por_px[0] = 0
        grade = por_px[rotulos]
        # municípios pequenos demais para ocupar um pixel: massa no primeiro vértice
        for i in np.nonzero(contagem[1:] == 0)[0]:
            x, y = px(*aneis_externos(feats[i]["geometry"])[0][0])
            grade[min(int(y), H - 1), min(int(x), W - 1)] += total[i + 1]
        return grade

    terra = (rotulos > 0).astype(np.float64)
    # área real do pixel varia com a latitude (a projeção estica longe do paralelo padrão)
    lat_linhas = lat1 - (np.arange(H) + 0.5) / escala
    area_px = (km_px**2) * np.cos(np.radians(lat_linhas))[:, None] / kx * np.ones((1, W))

    sigma = args.sigma_km / km_px
    densidade = gaussian_filter(espalhar(pop), sigma) / np.maximum(gaussian_filter(terra * area_px, sigma), 1e-9)
    densidade *= terra

    sigma_c = args.sigma_cor_km / km_px
    pct = 100 * gaussian_filter(espalhar(lula), sigma_c) / np.maximum(gaussian_filter(espalhar(validos), sigma_c), 1e-9)

    SAIDA.mkdir(parents=True, exist_ok=True)

    # cor: resolução cheia
    # a cor da terra se estende alguns px mar adentro para pintar o paredão do litoral
    dist, (iy, ix) = distance_transform_edt(terra == 0, return_indices=True)
    pct_estendido = pct[iy, ix]
    votos = np.where(dist <= 6, np.clip(np.round(pct_estendido * 2.5), 0, 250), 255).astype(np.uint8)
    Image.fromarray(votos, "L").save(SAIDA / "votos.png", optimize=True)

    # relevo: metade da resolução (vira a malha 3D)
    mw, mh = W // 2, H // 2
    dmax = float(densidade.max())
    q = np.log1p(densidade) / math.log1p(dmax)
    q_red = np.asarray(Image.fromarray(q.astype(np.float32), "F").resize((mw, mh), Image.BILINEAR))
    terra_red = np.asarray(Image.fromarray((terra * 255).astype(np.uint8), "L").resize((mw, mh), Image.BILINEAR)) > 127
    q16 = np.where(terra_red, np.clip(np.round(q_red * 65535), 0, 65535), 0).astype(np.uint16)
    rgb = np.stack([(q16 >> 8).astype(np.uint8), (q16 & 255).astype(np.uint8), np.zeros_like(q16, dtype=np.uint8)], -1)
    Image.fromarray(rgb, "RGB").save(SAIDA / "relevo.png", optimize=True)

    meta = {
        "cor": {"largura": W, "altura": H},
        "relevo": {"largura": mw, "altura": mh},
        "densidade_max": round(dmax, 2),
        "km_por_px": round(km_px, 4),
        "sigma_km": args.sigma_km,
        "sigma_cor_km": args.sigma_cor_km,
        "extensao": {"lon": [lon0, lon1], "lat": [lat0, lat1], "kx": kx},
        **dados["metadata"],
    }
    (SAIDA / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))

    sem_pixel = int((contagem[1:] == 0).sum())
    print(f"cor {W}x{H}, relevo {mw}x{mh}, {km_px:.2f} km/px, densidade máx. suavizada {dmax:,.0f} hab/km²")
    print(f"{sem_pixel} municípios menores que 1 px (massa no vértice)")
    print(f"população conservada: {espalhar(pop).sum():,.0f} de {pop.sum():,.0f}")
    for f in (SAIDA / "relevo.png", SAIDA / "votos.png"):
        print(f"{f.relative_to(ROOT)}: {f.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()

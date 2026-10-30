/* global deck */

// Faixas de % de votos válidos do Lula. Paleta ColorBrewer RdBu (8 classes).
const FAIXAS = [
  { min: 60, cor: [103, 0, 31],    rotulo: "Lula 60%+" },
  { min: 56, cor: [178, 24, 43],   rotulo: "Lula 56–60%" },
  { min: 53, cor: [214, 96, 77],   rotulo: "Lula 53–56%" },
  { min: 50, cor: [244, 165, 130], rotulo: "Lula 50–53%" },
  { min: 47, cor: [146, 197, 222], rotulo: "{outro} 50–53%" },
  { min: 44, cor: [67, 147, 195],  rotulo: "{outro} 53–56%" },
  { min: 40, cor: [33, 102, 172],  rotulo: "{outro} 56–60%" },
  { min: -1, cor: [5, 48, 97],     rotulo: "{outro} 60%+" },
];

const ALTURA_MAX = 700_000; // metros, para o maior valor com exagero 1×
const fmt = new Intl.NumberFormat("pt-BR");
const $ = (id) => document.getElementById(id);

const estado = { metrica: "pop", escala: "sqrt", exagero: 1, contorno: false };
let dados, deckgl, maximos;

const corDe = (pl) => (pl == null ? [60, 60, 60] : FAIXAS.find((f) => pl >= f.min).cor);

function valor(p, metrica) {
  if (metrica === "dens") return p.a > 0 ? p.p / p.a : 0;
  if (metrica === "votos") return p.l + p.o;
  return p.p;
}

function transformar(v, escala) {
  if (escala === "sqrt") return Math.sqrt(v);
  if (escala === "log") return Math.log10(1 + v);
  return v;
}

function elevacao(f) {
  const { metrica, escala, exagero } = estado;
  const t = transformar(valor(f.properties, metrica), escala);
  return (t / maximos[metrica][escala]) * ALTURA_MAX * exagero;
}

function camadas() {
  return [
    new deck.GeoJsonLayer({
      id: "municipios",
      data: dados,
      extruded: true,
      wireframe: estado.contorno,
      getElevation: elevacao,
      getFillColor: (f) => corDe(f.properties.pl),
      getLineColor: [0, 0, 0, 90],
      material: { ambient: 0.45, diffuse: 0.6, shininess: 24, specularColor: [40, 40, 40] },
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 90],
      updateTriggers: { getElevation: [estado.metrica, estado.escala, estado.exagero] },
      transitions: { getElevation: 600 },
    }),
  ];
}

function tooltip({ object: o }) {
  if (!o) return null;
  const p = o.properties;
  const outro = dados.metadata.outro;
  const pct = p.pl == null ? "sem dados" : `Lula ${p.pl.toFixed(1)}% · ${outro} ${(100 - p.pl).toFixed(1)}%`;
  return {
    html: `<b>${p.n} – ${p.uf}</b><br>
      População: ${fmt.format(p.p)}<br>
      Densidade: ${fmt.format(Math.round(p.p / p.a))} hab/km²<br>
      ${pct}<br>
      <span style="opacity:.7">Votos: Lula ${fmt.format(p.l)} · ${outro} ${fmt.format(p.o)}</span>`,
  };
}

function montarPainel() {
  const { metadata: m, features } = dados;
  const total = m.votos_lula + m.votos_outro;
  const pl = (100 * m.votos_lula) / total;
  $("subtitulo").textContent = `${m.ano} · 2º turno`;
  $("pct-lula").textContent = `${pl.toFixed(2)}%`;
  $("pct-outro").textContent = `${(100 - pl).toFixed(2)}%`;
  $("nome-outro").textContent = m.outro;
  $("barra-lula").style.width = `${pl}%`;

  const contagem = FAIXAS.map((fx) => features.filter((f) => f.properties.pl != null && corDe(f.properties.pl) === fx.cor).length);
  $("legenda").innerHTML =
    `<div class="leg-titulo">% de votos válidos no município · nº de municípios</div>` +
    FAIXAS.map((fx, i) => `
      <div class="leg-linha">
        <span class="leg-cor" style="background:rgb(${fx.cor})"></span>
        ${fx.rotulo.replace("{outro}", m.outro.split(" ")[0])}
        <span class="leg-n">${fmt.format(contagem[i])}</span>
      </div>`).join("");
}

function atualizar() {
  deckgl.setProps({ layers: camadas() });
}

function ligarControles() {
  $("metrica").onchange = (e) => { estado.metrica = e.target.value; atualizar(); };
  $("escala").onchange = (e) => { estado.escala = e.target.value; atualizar(); };
  $("exagero").oninput = (e) => {
    estado.exagero = Number(e.target.value);
    $("exagero-val").textContent = `${estado.exagero.toFixed(1)}×`;
    atualizar();
  };
  $("contorno").onchange = (e) => { estado.contorno = e.target.checked; atualizar(); };
}

async function iniciar() {
  dados = await (await fetch("data/municipios.geojson")).json();

  maximos = {};
  for (const metrica of ["pop", "dens", "votos"]) {
    const vmax = Math.max(...dados.features.map((f) => valor(f.properties, metrica)));
    maximos[metrica] = { sqrt: transformar(vmax, "sqrt"), log: transformar(vmax, "log"), linear: vmax };
  }

  const luzes = new deck.LightingEffect({
    ambiente: new deck.AmbientLight({ color: [255, 255, 255], intensity: 1.0 }),
    sol: new deck.DirectionalLight({ color: [255, 255, 255], intensity: 1.6, direction: [-3, -6, -8] }),
  });

  deckgl = new deck.DeckGL({
    container: "map",
    initialViewState: { longitude: -50, latitude: -20, zoom: 4.1, pitch: 55, bearing: -15, maxPitch: 85 },
    controller: true,
    effects: [luzes],
    layers: camadas(),
    getTooltip: tooltip,
  });

  montarPainel();
  ligarControles();
}

iniciar();

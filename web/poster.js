import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// Mesmas faixas do mapa interativo (paleta ColorBrewer RdBu, 8 classes), da mais azul para a mais vermelha.
const FAIXAS = [
  { min: -1, cor: [5, 48, 97] },
  { min: 40, cor: [33, 102, 172] },
  { min: 44, cor: [67, 147, 195] },
  { min: 47, cor: [146, 197, 222] },
  { min: 50, cor: [244, 165, 130] },
  { min: 53, cor: [214, 96, 77] },
  { min: 56, cor: [178, 24, 43] },
  { min: 60, cor: [103, 0, 31] },
];

const LARGURA_MUNDO = 100; // unidades do three.js
const ALTURA_MAX = 9;      // altura do pico com exagero 1×
const ALTURA_MAR = -0.5;   // o mar fica abaixo da "mesa" e some
const COR_MESA = [16, 19, 26];

const $ = (id) => document.getElementById(id);
const estado = { exagero: 1, perfil: "sqrt", cores: "faixas", sol: 315, elev: 25 };

let meta, densidade, votos, malha, textura, renderer, cena, camera, controles, sol;

async function carregarPixels(url) {
  const blob = await (await fetch(url)).blob();
  // sem conversão de cor, para os bytes chegarem exatamente como foram gravados
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
}

function corContinua(pct) {
  // interpola entre as cores das faixas, de 35% (azul escuro) a 65% (vermelho escuro)
  const t = Math.min(Math.max((pct - 35) / 30, 0), 1) * (FAIXAS.length - 1);
  const i = Math.min(Math.floor(t), FAIXAS.length - 2);
  const f = t - i;
  const a = FAIXAS[i].cor, b = FAIXAS[i + 1].cor;
  return [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * f);
}

function corFaixa(pct) {
  for (let i = FAIXAS.length - 1; i >= 0; i--) if (pct >= FAIXAS[i].min) return FAIXAS[i].cor;
  return FAIXAS[0].cor;
}

function pintarTextura() {
  const { largura: w, altura: h } = meta.cor;
  const canvas = textura.image;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  const corDe = estado.cores === "faixas" ? corFaixa : corContinua;
  for (let i = 0; i < w * h; i++) {
    const v = votos[i * 4];
    const c = v === 255 ? COR_MESA : corDe(v / 2.5);
    img.data[i * 4] = c[0];
    img.data[i * 4 + 1] = c[1];
    img.data[i * 4 + 2] = c[2];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  textura.needsUpdate = true;
}

function perfil(d) {
  if (estado.perfil === "cbrt") return Math.cbrt(d);
  if (estado.perfil === "log") return Math.log1p(d);
  return Math.sqrt(d);
}

function aplicarRelevo() {
  const { largura: w, altura: h } = meta.relevo;
  const pos = malha.geometry.attributes.position;
  const dmax = meta.densidade_max;
  const ref = perfil(dmax);
  const k = Math.log1p(dmax);
  for (let i = 0; i < w * h; i++) {
    const q = (densidade[i * 4] * 256 + densidade[i * 4 + 1]) / 65535;
    const d = Math.expm1(q * k);
    pos.setY(i, q === 0 ? ALTURA_MAR : (perfil(d) / ref) * ALTURA_MAX * estado.exagero);
  }
  pos.needsUpdate = true;
  malha.geometry.computeVertexNormals();
}

function posicionarSol() {
  const az = THREE.MathUtils.degToRad(estado.sol);
  const el = THREE.MathUtils.degToRad(estado.elev);
  const r = 120;
  // azimute 0° = norte (-z), 90° = leste (+x)
  sol.position.set(r * Math.cos(el) * Math.sin(az), r * Math.sin(el), -r * Math.cos(el) * Math.cos(az));
}

function montarCena() {
  const { largura: w, altura: h } = meta.relevo;
  const profundidade = (LARGURA_MUNDO * meta.cor.altura) / meta.cor.largura;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  $("cena").appendChild(renderer.domElement);

  cena = new THREE.Scene();
  cena.background = new THREE.Color(0x0b0d12);

  camera = new THREE.PerspectiveCamera(28, window.innerWidth / window.innerHeight, 1, 1000);
  camera.position.set(14, 105, 130);

  controles = new OrbitControls(camera, renderer.domElement);
  controles.target.set(10, 0, 4);
  controles.enableDamping = true;
  controles.maxPolarAngle = THREE.MathUtils.degToRad(85);
  controles.update();

  // superfície: PlaneGeometry com um vértice por pixel da grade de relevo
  const geo = new THREE.PlaneGeometry(LARGURA_MUNDO, profundidade, w - 1, h - 1);
  geo.rotateX(-Math.PI / 2);

  const canvas = document.createElement("canvas");
  canvas.width = meta.cor.largura;
  canvas.height = meta.cor.altura;
  textura = new THREE.CanvasTexture(canvas);
  textura.colorSpace = THREE.SRGBColorSpace;
  textura.anisotropy = renderer.capabilities.getMaxAnisotropy();

  malha = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    map: textura,
    roughness: 0.9,
    metalness: 0,
  }));
  malha.castShadow = true;
  malha.receiveShadow = true;
  cena.add(malha);

  // "mesa" escura que recebe a sombra do relevo
  const chao = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ color: 0x10131a, roughness: 1 }),
  );
  chao.rotateX(-Math.PI / 2);
  chao.position.y = -0.02;
  chao.receiveShadow = true;
  cena.add(chao);

  cena.add(new THREE.HemisphereLight(0xdfe6ff, 0x1a1410, 0.9));
  sol = new THREE.DirectionalLight(0xfff4e6, 2.6);
  sol.castShadow = true;
  sol.shadow.mapSize.set(4096, 4096);
  Object.assign(sol.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 300 });
  sol.shadow.bias = -0.0004;
  sol.shadow.normalBias = 0.04;
  cena.add(sol);
  posicionarSol();

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop(() => {
    controles.update();
    renderer.render(cena, camera);
  });
}

function montarLegenda() {
  const total = meta.votos_lula + meta.votos_outro;
  const pl = (100 * meta.votos_lula) / total;
  const outro = meta.outro;
  $("subtitulo").textContent = `2º turno presidencial · ${meta.ano}`;
  $("legenda").innerHTML = `
    <div class="leg-placar">
      <b style="color:#ef6548">${pl.toFixed(2)}%</b> Lula &nbsp;·&nbsp;
      <b style="color:#4393c3">${(100 - pl).toFixed(2)}%</b> ${outro}
    </div>
    <div class="leg-faixas">${[...FAIXAS].reverse().map((f) => `<span style="background:rgb(${f.cor})"></span>`).join("")}</div>
    <div class="leg-rotulos"><span>Lula 60%+</span><span>50%</span><span>${outro.split(" ")[0]} 60%+</span></div>`;
}

// Exporta a cena com 3× a resolução da tela, com título e legenda desenhados por cima.
async function baixarPng() {
  const botao = $("baixar");
  botao.disabled = true;
  const escala = 3;
  const w = window.innerWidth, h = window.innerHeight;
  const ratioOriginal = renderer.getPixelRatio();
  renderer.setPixelRatio(escala);
  renderer.setSize(w, h, false);
  renderer.render(cena, camera);

  const saida = document.createElement("canvas");
  saida.width = w * escala;
  saida.height = h * escala;
  const ctx = saida.getContext("2d");
  ctx.drawImage(renderer.domElement, 0, 0);
  renderer.setPixelRatio(ratioOriginal);
  renderer.setSize(w, h, false);

  desenharTextos(ctx, escala);
  saida.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `brasil-relevo-2turno-${meta.ano}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000); // revogar na hora cancela o download no Chrome
    botao.disabled = false;
  }, "image/png");
}

function desenharTextos(ctx, s) {
  const fonte = "system-ui, -apple-system, 'Segoe UI', sans-serif";
  const muted = "#8b93a7";
  const H = ctx.canvas.height, W = ctx.canvas.width;
  const total = meta.votos_lula + meta.votos_outro;
  const pl = (100 * meta.votos_lula) / total;

  ctx.textBaseline = "top";
  ctx.fillStyle = "#e8eaf0";
  ctx.font = `300 ${44 * s}px ${fonte}`;
  ctx.fillText("Brasil em relevo", 40 * s, 32 * s);
  ctx.fillStyle = muted;
  ctx.font = `${18 * s}px ${fonte}`;
  ctx.fillText(`2º turno presidencial · ${meta.ano}`, 40 * s, 86 * s);
  ctx.font = `${13 * s}px ${fonte}`;
  ctx.fillText("Altura = densidade populacional · Cor = % de votos válidos", 40 * s, 120 * s);

  const base = H - 40 * s;
  ctx.textBaseline = "alphabetic";
  ctx.font = `600 ${22 * s}px ${fonte}`;
  ctx.fillStyle = "#ef6548";
  const t1 = `${pl.toFixed(2)}%`;
  ctx.fillText(t1, 40 * s, base - 46 * s);
  let x = 40 * s + ctx.measureText(t1).width;
  ctx.font = `${15 * s}px ${fonte}`;
  ctx.fillStyle = "#e8eaf0";
  ctx.fillText(" Lula  ·  ", x, base - 46 * s);
  x += ctx.measureText(" Lula  ·  ").width;
  ctx.font = `600 ${22 * s}px ${fonte}`;
  ctx.fillStyle = "#4393c3";
  const t2 = `${(100 - pl).toFixed(2)}%`;
  ctx.fillText(t2, x, base - 46 * s);
  x += ctx.measureText(t2).width;
  ctx.font = `${15 * s}px ${fonte}`;
  ctx.fillStyle = "#e8eaf0";
  ctx.fillText(` ${meta.outro}`, x, base - 46 * s);

  [...FAIXAS].reverse().forEach((f, i) => {
    ctx.fillStyle = `rgb(${f.cor})`;
    ctx.fillRect((40 + i * 34) * s, base - 30 * s, 34 * s, 10 * s);
  });
  ctx.fillStyle = muted;
  ctx.font = `${12 * s}px ${fonte}`;
  ctx.textAlign = "left";
  ctx.fillText("Lula 60%+", 40 * s, base - 4 * s);
  ctx.textAlign = "center";
  ctx.fillText("50%", (40 + 136) * s, base - 4 * s);
  ctx.textAlign = "right";
  ctx.fillText(`${meta.outro.split(" ")[0]} 60%+`, (40 + 272) * s, base - 4 * s);
  ctx.font = `${11 * s}px ${fonte}`;
  ctx.fillText("Dados: TSE (votos válidos) · IBGE (população estimada e malha municipal)", W - 24 * s, H - 16 * s);
}

function ligarControles() {
  const deslizante = (id, chave, sufixo, depois) => {
    $(id).oninput = (e) => {
      estado[chave] = Number(e.target.value);
      $(`${id}-val`).textContent = sufixo(estado[chave]);
      depois();
    };
  };
  deslizante("exagero", "exagero", (v) => `${v.toFixed(1)}×`, aplicarRelevo);
  deslizante("sol", "sol", (v) => `${v}°`, posicionarSol);
  deslizante("elev", "elev", (v) => `${v}°`, posicionarSol);
  $("perfil").onchange = (e) => { estado.perfil = e.target.value; aplicarRelevo(); };
  $("cores").onchange = (e) => { estado.cores = e.target.value; pintarTextura(); };
  $("baixar").onclick = baixarPng;
  window.addEventListener("keydown", (e) => {
    if (e.key === "h" || e.key === "H") $("painel").classList.toggle("oculto");
  });
}

async function iniciar() {
  meta = await (await fetch("poster/meta.json")).json();
  [densidade, votos] = await Promise.all([carregarPixels("poster/relevo.png"), carregarPixels("poster/votos.png")]);
  montarCena();
  pintarTextura();
  aplicarRelevo();
  montarLegenda();
  ligarControles();
  $("carregando").remove();
}

iniciar();

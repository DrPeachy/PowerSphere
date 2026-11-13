/*
 * Adapted from three.js FresnelShader by alteredq.
 * https://github.com/mrdoob/three.js/blob/r108/examples/js/shaders/FresnelShader.js
 * Copyright three.js authors. SPDX-License-Identifier: MIT
 *
 * The fresnel term follows that shader. The sphere does not fill with a
 * reflected environment: the center stays clear and only the rim, specular
 * and caustic are drawn, so the wallpaper shows through.
 */

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;

uniform vec2 uRes;
uniform float uCurve;

out vec4 outColor;

void main() {
  vec2 center = uRes * 0.5;
  float R = max(min(uRes.x, uRes.y) * 0.5 - 0.6, 1.0);
  vec2 p = (gl_FragCoord.xy - center) / R;
  float r = length(p);
  if (r > 1.06) {
    outColor = vec4(0.0);
    return;
  }

  float z = sqrt(max(1.0 - min(r * r, 1.0), 0.0));
  vec3 N = normalize(vec3(p * uCurve, max(z, 0.045)));
  vec3 I = vec3(0.0, 0.0, -1.0);
  float fres = clamp(pow(1.0 + dot(I, N), 2.6), 0.0, 1.0);
  float rimBand = smoothstep(0.90, 0.995, r) * (1.0 - smoothstep(1.0, 1.04, r));
  float rim = fres * rimBand;

  float ang = atan(p.y, p.x);
  vec3 chroma = vec3(0.62 + 0.38 * cos(ang + 0.2), 0.84, 0.62 + 0.38 * cos(ang + 2.4));

  vec3 L = normalize(vec3(-0.5, 0.62, 0.6));
  float ndh = clamp(dot(N, normalize(L - I)), 0.0, 1.0);
  float spec = pow(ndh, 240.0);
  float specSoft = pow(ndh, 32.0) * 0.2;

  float arc = exp(-pow(ang + 0.9, 2.0) * 7.0);
  float cauRad = smoothstep(0.64, 0.8, r) * (1.0 - smoothstep(0.9, 0.97, r));
  float caustic = arc * cauRad;

  float contour = smoothstep(0.96, 0.992, r) * (1.0 - smoothstep(1.0, 1.04, r));
  float ul = smoothstep(0.25, 0.95, dot(normalize(p + vec2(1e-4)), vec2(-0.62, 0.78)));
  float shade = ul * smoothstep(0.8, 0.9, r) * (1.0 - smoothstep(0.92, 0.98, r));

  vec3 rgb = vec3(spec);
  float a = spec;
  rgb += vec3(0.94, 0.97, 1.0) * specSoft;
  a += specSoft;
  rgb += vec3(0.9, 0.96, 1.0) * rim;
  a += rim * 0.82;
  rgb += chroma * rim * 0.4;
  a += rim * 0.1;
  rgb += vec3(0.8, 0.94, 1.0) * caustic;
  a += caustic * 0.8;

  float darkA = contour * 0.32;
  rgb += vec3(0.01, 0.015, 0.03) * darkA;
  a += darkA;
  float shadeA = shade * 0.06;
  a += shadeA;

  outColor = vec4(min(rgb, vec3(1.0)), clamp(a, 0.0, 1.0));
}`;

export const glassDrag = { active: false };

const dragListeners = new Set<() => void>();

export function setGlassDrag(active: boolean) {
  glassDrag.active = active;
  for (const listener of dragListeners) listener();
}

const IDLE_CURVE = 1;
const PRESSED_CURVE = 0.94;

export function mountLiquidGlass(canvas: HTMLCanvasElement): () => void {
  const host = canvas.closest(".jewel");
  const body = canvas.parentElement;
  if (!(host instanceof HTMLElement) || !(body instanceof HTMLElement)) return () => {};

  let disposed = false;
  let raf = 0;
  let gl: WebGL2RenderingContext | null = null;
  let resLoc: WebGLUniformLocation | null = null;
  let curveLoc: WebGLUniformLocation | null = null;
  let curve = IDLE_CURVE;
  let last = 0;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  const resize = () => {
    if (!gl || disposed) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(2, Math.round(rect.width * dpr));
    const h = Math.max(2, Math.round(rect.height * dpr));
    if (rect.width < 2 || rect.height < 2) return false;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    return true;
  };

  const draw = () => {
    if (!gl) return;
    gl.uniform2f(resLoc, canvas.width, canvas.height);
    gl.uniform1f(curveLoc, curve);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    canvas.dataset.curve = curve.toFixed(3);
    canvas.dataset.stretch = "0";
    canvas.dataset.wobble = "0";
  };

  const boot = () => {
    gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
    if (!gl) return false;
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;
    const prog = gl.createProgram();
    if (!prog) return false;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
    gl.useProgram(prog);
    resLoc = gl.getUniformLocation(prog, "uRes");
    curveLoc = gl.getUniformLocation(prog, "uCurve");
    return resLoc !== null && curveLoc !== null;
  };

  const fail = () => {
    body.classList.remove("webgl");
    stop();
    gl = null;
  };

  const tick = (now: number) => {
    if (disposed || !gl) return;
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    const hover =
      !glassDrag.active &&
      (host.matches(":hover") || host.matches(":focus-visible") || host.getAttribute("aria-pressed") === "true");
    const target = glassDrag.active ? IDLE_CURVE : hover ? PRESSED_CURVE : IDLE_CURVE;
    if (glassDrag.active || reduce) curve = target;
    else curve += (target - curve) * (1 - Math.exp(-dt / 0.12));
    if (!resize()) return;
    draw();
    if (!glassDrag.active && Math.abs(curve - target) > 0.003) raf = requestAnimationFrame(tick);
    else {
      curve = target;
      draw();
      raf = 0;
    }
  };

  const kick = () => {
    if (disposed || !gl || raf) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  };

  if (!boot() || !resize()) {
    fail();
    return () => {
      disposed = true;
    };
  }
  draw();
  body.classList.add("webgl");

  const onLost = (event: Event) => {
    event.preventDefault();
    fail();
  };
  const onRestored = () => {
    if (disposed) return;
    if (!boot() || !resize()) fail();
    else {
      body.classList.add("webgl");
      draw();
    }
  };
  const ro = new ResizeObserver(() => {
    if (!gl) return;
    if (resize()) draw();
  });
  ro.observe(canvas);
  dragListeners.add(kick);
  host.addEventListener("pointerenter", kick);
  host.addEventListener("pointerleave", kick);
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return () => {
    disposed = true;
    stop();
    ro.disconnect();
    dragListeners.delete(kick);
    host.removeEventListener("pointerenter", kick);
    host.removeEventListener("pointerleave", kick);
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
    body.classList.remove("webgl");
    gl = null;
  };
}

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

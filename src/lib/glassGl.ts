/*
 * Adapted from three.js FresnelShader by alteredq.
 * https://github.com/mrdoob/three.js/blob/r108/examples/js/shaders/FresnelShader.js
 * Copyright three.js authors. SPDX-License-Identifier: MIT
 *
 * Reflect, chromatic refract, and the Schlick fresnel mix follow that
 * shader. The mesh and cubemap are replaced by an analytic sphere and a
 * procedural environment, because this window cannot read the desktop.
 * There is no noise, blur, frost, stretch, or wobble.
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

vec3 envMap(vec3 dir) {
  vec3 d = normalize(dir);
  float sky = d.y * 0.5 + 0.5;
  vec3 c = mix(vec3(0.10, 0.16, 0.28), vec3(0.93, 0.96, 1.0), smoothstep(0.0, 1.0, sky));
  float band = smoothstep(0.55, 0.05, abs(d.x * 0.85 + d.y * 0.25));
  c = mix(c, vec3(0.08, 0.38, 0.95), band * 0.75);
  c = mix(c, vec3(0.95, 0.28, 0.42), smoothstep(0.62, 0.05, length(d.xy - vec2(0.62, -0.42))));
  c = mix(c, vec3(0.12, 0.75, 0.58), smoothstep(0.58, 0.05, length(d.xy - vec2(-0.55, 0.48))));
  c = mix(c, vec3(1.0, 0.84, 0.32), smoothstep(0.5, 0.05, length(d.xz - vec2(-0.25, 0.6))));
  return c;
}

void main() {
  vec2 center = uRes * 0.5;
  float R = max(min(uRes.x, uRes.y) * 0.5 - 1.15, 1.0);
  vec2 q = gl_FragCoord.xy - center;
  vec2 p = q / R;
  float r2 = dot(p, p);
  float aa = 1.25 / R;
  float inside = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, sqrt(r2));
  if (inside < 0.002) {
    outColor = vec4(0.0);
    return;
  }

  float z = sqrt(max(1.0 - min(r2, 1.0), 0.0));
  vec3 N = normalize(vec3(p * uCurve, max(z, 0.02)));
  vec3 I = vec3(0.0, 0.0, -1.0);

  vec3 reflected = envMap(reflect(I, N));
  vec3 refrR = refract(I, N, 0.74);
  vec3 refrG = refract(I, N, 0.752);
  vec3 refrB = refract(I, N, 0.766);
  if (dot(refrR, refrR) < 0.001) refrR = reflect(I, N);
  if (dot(refrG, refrG) < 0.001) refrG = reflect(I, N);
  if (dot(refrB, refrB) < 0.001) refrB = reflect(I, N);
  vec3 refracted = vec3(envMap(refrR).r, envMap(refrG).g, envMap(refrB).b);

  float fresnel = 0.06 + pow(1.0 + dot(I, N), 3.0);
  fresnel = clamp(fresnel, 0.0, 1.0);
  vec3 col = mix(refracted, reflected, fresnel);

  vec3 L = normalize(vec3(-0.42, 0.58, 0.7));
  vec3 H = normalize(L - I);
  float ndh = clamp(dot(N, H), 0.0, 1.0);
  float spec = pow(ndh, 160.0);
  float specSoft = pow(ndh, 14.0) * 0.18;
  col += vec3(spec + specSoft);

  vec2 cau = p - vec2(0.46, -0.52);
  float caustic = exp(-dot(cau, cau) / 0.035) * smoothstep(0.2, 0.62, length(p));
  col += vec3(0.72, 0.9, 1.0) * caustic * 0.85;

  float rim = smoothstep(0.9, 1.0, length(p));
  col += rim * mix(vec3(0.03, 0.05, 0.09), vec3(1.0), fresnel);

  float alpha = inside * clamp(0.045 + fresnel * 0.62 + spec * 0.95 + caustic * 0.4 + rim * 0.35, 0.0, 1.0);
  outColor = vec4(min(col, vec3(1.0)) * alpha, alpha);
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

/*
 * Adapted from "Liquid Glass" by Prasenjit (StarKnightt).
 * https://github.com/StarKnightt/liquid-glass
 * Copyright (c) 2026 Prasenjit (StarKnightt)
 * SPDX-License-Identifier: MIT
 *
 * The dome normal, the rim refraction bend, the chromatic split, the
 * Blinn specular and the Fresnel rim follow that shader. Cursor motion,
 * ripples, frost and the page-content texture are not used. Curvature is
 * a uniform (convex through slightly concave), and the refracted sample
 * is a procedural environment because this window cannot read the desktop.
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

vec3 envAt(vec2 uv) {
  vec2 p = uv * 2.0 - 1.0;
  float lift = 0.86 + 0.08 * p.y + 0.03 * p.x;
  vec3 c = vec3(lift, lift + 0.008, lift + 0.03);
  float cool = smoothstep(1.15, 0.05, length(p - vec2(-0.45, 0.55)));
  float warm = smoothstep(1.25, 0.1, length(p - vec2(0.7, -0.6)));
  c += vec3(0.01, 0.04, 0.08) * cool;
  c += vec3(0.06, 0.02, 0.03) * warm;
  return c;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 center = uRes * 0.5;
  float R = min(uRes.x, uRes.y) * 0.5 - 1.25;
  vec2 q = frag - center;
  float r = length(q);
  float d = r - R;
  float inside = smoothstep(1.25, -1.25, d);
  if (inside < 0.002) {
    outColor = vec4(0.0);
    return;
  }

  float r01 = clamp(r / max(R, 1.0), 0.0, 1.0);
  float h = sqrt(max(1.0 - r01 * r01, 0.0));
  vec3 N = normalize(vec3(uCurve * q / max(R, 1.0), max(h, 0.045) * 1.15));

  float bend = 1.0 - h;
  vec2 refr = -N.xy * bend * 0.55 * R * 0.9;
  float ca = 0.16 * 0.55;
  vec2 base = center + q * 0.35;
  vec3 tint = vec3(
    envAt((base + refr * (1.0 + ca)) / uRes).r,
    envAt((base + refr) / uRes).g,
    envAt((base + refr * (1.0 - ca)) / uRes).b
  );

  vec3 L = normalize(vec3(-0.35, 0.55, 0.75));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float ndh = max(dot(N, H), 0.0);
  float spec = pow(ndh, 18.0) * 0.62 + pow(ndh, 6.0) * 0.34;
  float fres = pow(1.0 - clamp(N.z, 0.0, 1.0), 2.4);
  float away = dot(normalize(N.xy + vec2(1e-4)), normalize(vec2(-0.55, 0.65)));
  float shade = smoothstep(0.2, 1.0, -away) * 0.08;

  vec3 rgb = mix(vec3(0.97, 0.98, 1.0), tint, 0.06 + fres * 0.42);
  rgb *= 1.0 - shade;
  rgb += vec3(spec);
  rgb += fres * vec3(0.62, 0.78, 0.96);
  rgb += smoothstep(2.2, 0.0, abs(d)) * 0.18;

  float alpha = inside * clamp(0.2 + fres * 0.58 + spec * 0.72, 0.0, 1.0);
  outColor = vec4(min(rgb, vec3(1.0)) * alpha, alpha);
}`;

const IDLE_CURVE = 1;
const PRESSED_CURVE = -0.28;
const TAU = 0.07;

export function mountLiquidGlass(canvas: HTMLCanvasElement): () => void {
  const host = canvas.closest(".jewel");
  const body = canvas.parentElement;
  if (!(host instanceof HTMLElement) || !(body instanceof HTMLElement)) return () => {};

  let disposed = false;
  let raf = 0;
  let gl: WebGL2RenderingContext | null = null;
  let curve = IDLE_CURVE;
  let target = IDLE_CURVE;
  let last = 0;
  let resLoc: WebGLUniformLocation | null = null;
  let curveLoc: WebGLUniformLocation | null = null;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  const draw = () => {
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
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(resLoc, w, h);
    gl.uniform1f(curveLoc, curve);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    canvas.dataset.curve = curve.toFixed(3);
    return true;
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

  if (!boot() || !draw()) {
    fail();
    return () => {
      disposed = true;
    };
  }
  body.classList.add("webgl");

  const kick = () => {
    if (disposed || !gl) return;
    if (reduce) {
      curve = target;
      draw();
      return;
    }
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  };

  const tick = (now: number) => {
    if (disposed || !gl) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    curve += (target - curve) * (1 - Math.exp(-dt / TAU));
    draw();
    if (Math.abs(target - curve) > 0.004) raf = requestAnimationFrame(tick);
    else {
      curve = target;
      draw();
      raf = 0;
    }
  };

  const sync = () => {
    const pressed =
      host.matches(":hover") ||
      host.matches(":focus-visible") ||
      host.getAttribute("aria-pressed") === "true";
    const next = pressed ? PRESSED_CURVE : IDLE_CURVE;
    if (next === target && !raf) return;
    target = next;
    kick();
  };

  const onLost = (event: Event) => {
    event.preventDefault();
    fail();
  };
  const onRestored = () => {
    if (disposed) return;
    if (!boot() || !draw()) fail();
    else body.classList.add("webgl");
  };

  const observer = new MutationObserver(sync);
  observer.observe(host, { attributes: true, attributeFilter: ["aria-pressed"] });
  const ro = new ResizeObserver(() => {
    if (!gl) return;
    draw();
  });
  ro.observe(canvas);
  host.addEventListener("pointerenter", sync);
  host.addEventListener("pointerleave", sync);
  host.addEventListener("focusin", sync);
  host.addEventListener("focusout", sync);
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return () => {
    disposed = true;
    stop();
    observer.disconnect();
    ro.disconnect();
    host.removeEventListener("pointerenter", sync);
    host.removeEventListener("pointerleave", sync);
    host.removeEventListener("focusin", sync);
    host.removeEventListener("focusout", sync);
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

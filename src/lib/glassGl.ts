/*
 * Adapted from "Liquid Glass" by Prasenjit (StarKnightt).
 * https://github.com/StarKnightt/liquid-glass
 * Copyright (c) 2026 Prasenjit (StarKnightt)
 * SPDX-License-Identifier: MIT
 *
 * Dome normal, rim refraction, chromatic split, Blinn specular, Fresnel,
 * and the velocity stretch / angular wobble / press scale follow that
 * shader. The page texture is replaced by a procedural environment
 * because this window cannot read the desktop behind it.
 */

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;

uniform vec2 uRes;
uniform float uTime;
uniform float uDpr;
uniform float uCurve;
uniform vec4 uMotion;
uniform float uPress;

out vec4 outColor;

vec3 envAt(vec2 uv) {
  vec2 p = uv * 2.0 - 1.0;
  vec3 c = vec3(0.9, 0.93, 0.98);
  c = mix(c, vec3(0.16, 0.42, 0.98), smoothstep(0.62, 0.0, length(p - vec2(-0.55, 0.42))));
  c = mix(c, vec3(0.98, 0.28, 0.48), smoothstep(0.52, 0.0, length(p - vec2(0.62, -0.38))));
  c = mix(c, vec3(0.05, 0.72, 0.58), smoothstep(0.46, 0.0, length(p - vec2(0.12, 0.72))));
  c = mix(c, vec3(1.0, 0.78, 0.22), smoothstep(0.4, 0.0, length(p - vec2(-0.72, -0.58))));
  float band = smoothstep(0.07, 0.0, abs(p.x * 0.65 + p.y * 0.35 + 0.12));
  c = mix(c, vec3(1.0), band * 0.9);
  return c;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 center = uRes * 0.5;
  float margin = 20.0 * uDpr;
  float R = max((min(uRes.x, uRes.y) - margin * 2.0) * 0.5, 1.0) * uPress;

  vec2 q = frag - center;
  vec2 dir = uMotion.xy;
  float stretch = uMotion.z;
  if (stretch > 0.001 && dot(dir, dir) > 0.25) {
    vec2 tangent = vec2(dir.y, -dir.x);
    float along = dot(q, dir) / (1.0 + stretch);
    float across = dot(q, tangent) * (1.0 + stretch * 0.5);
    q = dir * along + tangent * across;
  }

  float ang = atan(q.y, q.x);
  float wob = uMotion.w * (
      0.030 * sin(ang * 3.0 + uTime * 2.1)
    + 0.022 * sin(ang * 5.0 - uTime * 3.3)
    + 0.014 * sin(ang * 7.0 + uTime * 4.7)
  );
  float r = length(q);
  float Rw = R * (1.0 + wob);
  float d = r - Rw;
  float aa = 1.5 * uDpr;
  float inside = smoothstep(aa, -aa, d);
  if (inside < 0.002) {
    outColor = vec4(0.0);
    return;
  }

  float r01 = clamp(r / max(Rw, 1.0), 0.0, 1.0);
  float h = sqrt(max(1.0 - r01 * r01, 0.0));
  vec3 N = normalize(vec3(uCurve * q / max(Rw, 1.0), max(h, 0.045) * 1.15));
  float bend = 1.0 - h;
  vec2 refr = -N.xy * bend * 0.9 * R;
  float ca = 0.22;
  vec2 mfrag = center + q / 1.06;
  vec3 glass = vec3(
    envAt((mfrag + refr * (1.0 + ca)) / uRes).r,
    envAt((mfrag + refr) / uRes).g,
    envAt((mfrag + refr * (1.0 - ca)) / uRes).b
  );

  vec3 L = normalize(vec3(-0.35, 0.55, 0.75));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float ndh = max(dot(N, H), 0.0);
  float spec = pow(ndh, 90.0) * 0.95 + pow(ndh, 18.0) * 0.18;
  float fres = pow(1.0 - clamp(N.z, 0.0, 1.0), 2.5);
  glass += vec3(spec);
  glass += fres * vec3(0.78, 0.9, 1.0) * 0.55;
  glass += smoothstep(aa * 2.5, 0.0, abs(d)) * 0.38;

  float cover = inside * clamp(0.04 + bend * 0.78 + fres * 0.5 + spec * 0.85, 0.0, 1.0);
  outColor = vec4(min(glass, vec3(1.0)) * cover, cover);
}`;

/** Screen-space drag velocity in CSS px/s. y grows downward. */
export const glassDrag = { active: false, vx: 0, vy: 0 };

const dragListeners = new Set<() => void>();

export function setGlassDrag(active: boolean, vx = 0, vy = 0) {
  glassDrag.active = active;
  glassDrag.vx = vx;
  glassDrag.vy = vy;
  for (const listener of dragListeners) listener();
}

const IDLE_CURVE = 1;
const PRESSED_CURVE = -0.22;

export function mountLiquidGlass(canvas: HTMLCanvasElement): () => void {
  const host = canvas.closest(".jewel");
  const body = canvas.parentElement;
  if (!(host instanceof HTMLElement) || !(body instanceof HTMLElement)) return () => {};

  let disposed = false;
  let raf = 0;
  let gl: WebGL2RenderingContext | null = null;
  let resLoc: WebGLUniformLocation | null = null;
  let timeLoc: WebGLUniformLocation | null = null;
  let dprLoc: WebGLUniformLocation | null = null;
  let curveLoc: WebGLUniformLocation | null = null;
  let motionLoc: WebGLUniformLocation | null = null;
  let pressLoc: WebGLUniformLocation | null = null;

  let curve = IDLE_CURVE;
  let curveTarget = IDLE_CURVE;
  let press = 1;
  let pressVel = 0;
  let dirX = 0;
  let dirY = 1;
  let stretch = 0;
  let wobble = 0;
  let wobbleVel = 0;
  let last = 0;
  let time0 = 0;
  let wasPressed = false;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  const draw = (time: number, dpr: number) => {
    if (!gl) return;
    gl.uniform2f(resLoc, canvas.width, canvas.height);
    gl.uniform1f(timeLoc, time);
    gl.uniform1f(dprLoc, dpr);
    gl.uniform1f(curveLoc, curve);
    gl.uniform4f(motionLoc, dirX, dirY, stretch, wobble);
    gl.uniform1f(pressLoc, press);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    canvas.dataset.curve = curve.toFixed(3);
    canvas.dataset.stretch = stretch.toFixed(3);
    canvas.dataset.wobble = wobble.toFixed(3);
    canvas.dataset.press = press.toFixed(3);
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
    timeLoc = gl.getUniformLocation(prog, "uTime");
    dprLoc = gl.getUniformLocation(prog, "uDpr");
    curveLoc = gl.getUniformLocation(prog, "uCurve");
    motionLoc = gl.getUniformLocation(prog, "uMotion");
    pressLoc = gl.getUniformLocation(prog, "uPress");
    return resLoc !== null && curveLoc !== null && motionLoc !== null && pressLoc !== null;
  };

  const fail = () => {
    body.classList.remove("webgl");
    stop();
    gl = null;
  };

  const moving = () =>
    glassDrag.active ||
    Math.abs(curve - curveTarget) > 0.004 ||
    Math.abs(press - (host.matches(":hover") || host.matches(":focus-visible") ? 0.94 : 1)) > 0.004 ||
    Math.abs(pressVel) > 0.01 ||
    stretch > 0.004 ||
    wobble > 0.004 ||
    Math.abs(wobbleVel) > 0.01;

  const tick = (now: number) => {
    if (disposed || !gl) return;
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    const pressed =
      host.matches(":hover") ||
      host.matches(":focus-visible") ||
      host.getAttribute("aria-pressed") === "true";
    curveTarget = pressed ? PRESSED_CURVE : IDLE_CURVE;
    if (reduce) {
      curve = curveTarget;
      press = pressed ? 0.94 : 1;
      stretch = 0;
      wobble = 0;
      wobbleVel = 0;
    } else {
      curve += (curveTarget - curve) * (1 - Math.exp(-dt / 0.07));
      const pressTarget = pressed && !glassDrag.active ? 0.94 : 1;
      pressVel += (pressTarget - press) * 70 * dt;
      pressVel *= Math.exp(-7 * dt);
      press += pressVel * dt;
      if (pressed && !wasPressed) wobbleVel += 0.65;
      const vx = glassDrag.vx;
      const vy = -glassDrag.vy;
      const speed = Math.hypot(vx, vy);
      if (speed > 12) {
        dirX = vx / speed;
        dirY = vy / speed;
      }
      const stretchTarget = glassDrag.active ? Math.min(speed / 1100, 0.28) : 0;
      stretch += (stretchTarget - stretch) * (1 - Math.exp(-12 * dt));
      const wobbleTarget = glassDrag.active ? Math.min(speed / 900, 0.8) : 0;
      wobbleVel += (wobbleTarget - wobble) * 36 * dt;
      wobbleVel *= Math.exp(-3.4 * dt);
      wobble += wobbleVel * dt;
      wobble = Math.max(0, Math.min(wobble, 1.1));
    }
    wasPressed = pressed;
    if (!resize()) return;
    draw((now - time0) / 1000, Math.min(window.devicePixelRatio || 1, 2));
    if (moving()) raf = requestAnimationFrame(tick);
    else {
      curve = curveTarget;
      draw((now - time0) / 1000, Math.min(window.devicePixelRatio || 1, 2));
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
  time0 = performance.now();
  draw(0, Math.min(window.devicePixelRatio || 1, 2));
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
      draw(0, Math.min(window.devicePixelRatio || 1, 2));
    }
  };
  const ro = new ResizeObserver(() => {
    if (!gl) return;
    if (resize()) draw((performance.now() - time0) / 1000, Math.min(window.devicePixelRatio || 1, 2));
  });
  ro.observe(canvas);
  dragListeners.add(kick);
  host.addEventListener("pointerenter", kick);
  host.addEventListener("pointerleave", kick);
  host.addEventListener("pointerdown", kick);
  host.addEventListener("pointerup", kick);
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return () => {
    disposed = true;
    stop();
    ro.disconnect();
    dragListeners.delete(kick);
    host.removeEventListener("pointerenter", kick);
    host.removeEventListener("pointerleave", kick);
    host.removeEventListener("pointerdown", kick);
    host.removeEventListener("pointerup", kick);
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

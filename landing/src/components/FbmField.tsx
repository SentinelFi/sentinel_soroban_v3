import { useEffect, useRef } from "react";

/* Domain-warped fractional Brownian motion on a full-screen triangle.
   Noise is fed into noise twice, so the field flows like weather instead of
   sitting there as static. Left smooth — no dither/quantise pass — and kept
   to the page palette: black, the Stellar blue, a whisper of accent at the
   peaks. */

const VERT = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 uRes;
uniform float uTime;
uniform vec2 uPointer;
uniform float uLens;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return s;
}

void main() {
  // Aspect-correct and centred, so the field does not stretch on wide screens.
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 uv = gl_FragCoord.xy / uRes;

  // Very slow. This is atmosphere, not spectacle.
  float t = uTime * 0.05;

  // Two rounds of domain warping: fbm displaced by fbm, displaced again.
  // The drift is purely vertical — a scalar offset here would push the whole
  // field diagonally, which reads as the weather sliding off to one side.
  vec2 q = vec2(fbm(p * 1.6 + vec2(0.0, t)), fbm(p * 1.6 + vec2(5.2, -t)));
  vec2 r = vec2(fbm(p * 1.6 + 3.0 * q + vec2(1.7, 9.2)),
                fbm(p * 1.6 + 3.0 * q + vec2(8.3, 2.8)));
  float field = fbm(p * 1.6 + 2.4 * r + vec2(0.0, t * 0.5));

  // Barely off-centre: enough that a form emerges instead of an even wash,
  // little enough that the opening frame is balanced left to right.
  vec2 c = p - vec2(0.06, 0.10);
  field += 0.30 * exp(-3.0 * dot(c, c));

  // The field lifts under the cursor.
  vec2 mp = (uPointer - 0.5 * uRes) / uRes.y;
  float d = distance(p, mp);
  field += uLens * 0.32 * exp(-9.0 * d * d);

  // Radial fade so the edges sink into the page instead of ending at a seam.
  field *= smoothstep(1.15, 0.25, length(p));

  // Dissolve through the lower third. The canvas stops at the hero's bottom
  // edge, so without this the sky ends on a hard horizontal line where the
  // next section begins.
  field *= smoothstep(0.0, 0.34, uv.y);

  // Legibility scrim: hold the field down through the ellipse where the
  // headline and buttons sit, so the copy never fights the texture.
  float scrim = smoothstep(0.0, 0.62, length(p * vec2(0.7, 1.4)));
  field *= mix(0.28, 1.0, scrim);

  field = clamp(field * 1.45 - 0.34, 0.0, 1.0);

  vec3 deep = vec3(0.051, 0.486, 0.659);
  vec3 warm = vec3(0.914, 0.725, 0.286);
  vec3 col = mix(vec3(0.0), deep, smoothstep(0.0, 0.9, field));
  col = mix(col, warm, smoothstep(0.6, 1.0, field) * 0.20);

  // Premultiplied, matching the default canvas compositing.
  float a = field * 0.62;
  gl_FragColor = vec4(col * a, a);
}`;

/** Render at half CSS resolution. The field is low-frequency, so the upscale
 *  is invisible and the shader costs a quarter as much. */
const SCALE = 0.5;

export default function FbmField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    });
    // No WebGL: the starfield and glow orbs still carry the hero.
    if (!gl) return;

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };

    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    const prog = vs && fs ? gl.createProgram() : null;
    if (!vs || !fs || !prog) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      return;
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, "uRes");
    const uTime = gl.getUniformLocation(prog, "uTime");
    const uPointer = gl.getUniformLocation(prog, "uPointer");
    const uLens = gl.getUniformLocation(prog, "uLens");

    let w = 0;
    let h = 0;
    const resize = () => {
      const cw = Math.max(1, Math.round(canvas.clientWidth * SCALE));
      const ch = Math.max(1, Math.round(canvas.clientHeight * SCALE));
      if (cw === w && ch === h) return;
      w = cw;
      h = ch;
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
    };

    let pointer: [number, number] = [-1e4, -1e4];
    let lensTarget = 0;
    let lens = 0;
    let seconds = 0;

    const draw = () => {
      resize();
      lens += (lensTarget - lens) * 0.08;
      gl.uniform1f(uTime, seconds);
      gl.uniform2f(uPointer, pointer[0], pointer[1]);
      gl.uniform1f(uLens, lens);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    // One synchronous frame before any rAF, so the hero is never blank.
    draw();

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

    let raf = 0;
    let running = false;
    const loop = (ms: number) => {
      seconds = ms / 1000;
      draw();
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (running || reduced.matches) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (!running) return;
      running = false;
      cancelAnimationFrame(raf);
    };

    // Animate only while the hero is on screen and the tab is in front.
    let onScreen = true;
    const sync = () => (onScreen && !document.hidden ? start() : stop());

    const io = new IntersectionObserver((entries) => {
      onScreen = entries[0].isIntersecting;
      sync();
    });
    io.observe(canvas);

    const ro = new ResizeObserver(() => {
      if (!running) draw();
    });
    ro.observe(canvas);

    // The pointer is read from the window, not the canvas, so the hero copy
    // layered on top does not block the lens.
    const onPointerMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const inside =
        e.clientY >= r.top &&
        e.clientY <= r.bottom &&
        e.clientX >= r.left &&
        e.clientX <= r.right;
      lensTarget = inside ? 1 : 0;
      if (inside) {
        // GL's origin is bottom-left.
        pointer = [(e.clientX - r.left) * SCALE, (r.bottom - e.clientY) * SCALE];
        if (!running) draw();
      }
    };
    const onPointerLeave = () => {
      lensTarget = 0;
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerleave", onPointerLeave);
    document.addEventListener("visibilitychange", sync);
    reduced.addEventListener("change", sync);
    sync();

    return () => {
      stop();
      io.disconnect();
      ro.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", sync);
      reduced.removeEventListener("change", sync);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 h-full w-full"
    />
  );
}

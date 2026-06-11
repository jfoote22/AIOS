import { useEffect, useRef } from "react";

interface Props {
  /** One color per recent neuron (by category). Drives the constellation. */
  seedColors: string[];
  /** Only animate while the tab is visible. */
  active: boolean;
  onOpen: () => void;
}

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
}

const prefersReducedMotion =
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Ambient "living brain" — a drifting constellation of neurons (seeded by the
 * real category colors of recent neurons) with proximity links and a slow pulse
 * wave echoing the Second Brain's network-pulse rig. Canvas + rAF; cheap.
 */
export default function BrainHero({ seedColors, active, onOpen }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef<Node[]>([]);
  const rafRef = useRef<number | null>(null);
  const pulseRef = useRef<{ t: number }>({ t: 0 });

  // (Re)seed nodes when the data changes.
  useEffect(() => {
    const colors =
      seedColors.length > 0
        ? seedColors
        : Array.from({ length: 22 }, () => "#2a3340"); // faint placeholder when empty
    const count = Math.min(64, Math.max(18, colors.length));
    nodesRef.current = Array.from({ length: count }, (_, i) => {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.pow(Math.random(), 0.7); // bias toward center
      return {
        x: 0.5 + Math.cos(angle) * radius * 0.42,
        y: 0.5 + Math.sin(angle) * radius * 0.42,
        vx: (Math.random() - 0.5) * 0.0006,
        vy: (Math.random() - 0.5) * 0.0006,
        r: 1.6 + Math.random() * 2.4,
        color: colors[i % colors.length],
      };
    });
  }, [seedColors]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 0;
    let h = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      w = wrap.clientWidth;
      h = wrap.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const draw = (animate: boolean) => {
      const nodes = nodesRef.current;
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;

      // links (proximity)
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        const ax = a.x * w;
        const ay = a.y * h;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const bx = b.x * w;
          const by = b.y * h;
          const dx = ax - bx;
          const dy = ay - by;
          const d2 = dx * dx + dy * dy;
          const max = 120;
          if (d2 < max * max) {
            const alpha = (1 - Math.sqrt(d2) / max) * 0.22;
            ctx.strokeStyle = `rgba(56,189,248,${alpha})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
          }
        }
      }

      // pulse wave ring
      if (animate) {
        pulseRef.current.t += 0.006;
        if (pulseRef.current.t > 1) pulseRef.current.t = 0;
      }
      const pt = pulseRef.current.t;
      const maxR = Math.min(w, h) * 0.46;
      const pr = pt * maxR;
      ctx.strokeStyle = `rgba(34,211,238,${(1 - pt) * 0.35})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, pr, 0, Math.PI * 2);
      ctx.stroke();

      // nodes (glow + core)
      for (const n of nodes) {
        const x = n.x * w;
        const y = n.y * h;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, n.r * 4);
        glow.addColorStop(0, n.color + "cc");
        glow.addColorStop(1, n.color + "00");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, n.r * 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = n.color;
        ctx.beginPath();
        ctx.arc(x, y, n.r, 0, Math.PI * 2);
        ctx.fill();

        if (animate) {
          n.x += n.vx;
          n.y += n.vy;
          // keep within a soft disc around center
          const ddx = n.x - 0.5;
          const ddy = n.y - 0.5;
          if (ddx * ddx + ddy * ddy > 0.46 * 0.46) {
            n.vx *= -1;
            n.vy *= -1;
          }
        }
      }
    };

    if (active && !prefersReducedMotion) {
      const loop = () => {
        draw(true);
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    } else {
      draw(false);
    }

    return () => {
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active, seedColors]);

  return (
    <div
      ref={wrapRef}
      onClick={onOpen}
      className="relative w-full h-full cursor-pointer group"
      role="button"
      aria-label="Open the full Second Brain"
      title="Open the full Second Brain"
    >
      <canvas ref={canvasRef} className="absolute inset-0" />
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,transparent_55%,var(--color-surface)_100%)]" />
    </div>
  );
}

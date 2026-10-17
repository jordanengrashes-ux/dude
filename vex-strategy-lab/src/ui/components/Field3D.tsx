import { useEffect, useRef } from 'react';
import { FieldScene } from '../three/FieldScene';
import { runner } from '../simRunner';
import { store, useApp } from '../store';
import type { StepInfo } from '../../planner/model';

/** Interactive 3D field (Three.js). Rendering runs every animation frame; physics advances via the runner. */
export function Field3D({ steps }: { steps: StepInfo[] | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<FieldScene | null>(null);
  const camera = useApp((s) => s.camera);
  const show = useApp((s) => s.show);
  const userSlot = useApp((s) => s.userSlot);
  const slots = useApp((s) => s.slots);

  useEffect(() => {
    const sc = new FieldScene(canvas.current!);
    sceneRef.current = sc;
    // ?debug exposes the scene for automated screenshots / console inspection
    if (new URLSearchParams(window.location.search).has('debug')) (window as unknown as { __vexScene?: FieldScene }).__vexScene = sc;
    const ro = new ResizeObserver(() => sc.resize(wrap.current!.clientWidth, wrap.current!.clientHeight));
    ro.observe(wrap.current!);
    let raf = 0;
    let last = performance.now();
    let trailTick = 0;
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      runner.frame(dt);
      if (runner.sim) {
        sc.sync(runner.sim, store.get().selection);
        if (trailTick++ % 10 === 0) sc.setTrails(runner.sim.robots.map((r) => ({ id: r.id, alliance: r.alliance, pts: r.trail })));
      }
      sc.render();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      sc.dispose();
    };
  }, []);

  useEffect(() => sceneRef.current?.setCamera(camera), [camera]);
  useEffect(() => sceneRef.current?.setVisibility(show), [show]);
  useEffect(() => {
    const alliance = slots.find((s) => s.slot === userSlot)?.alliance ?? 'red';
    sceneRef.current?.setRoute(steps, alliance);
  }, [steps, userSlot, slots]);

  const onClick = (e: React.MouseEvent) => {
    const pick = sceneRef.current?.pick(e.clientX, e.clientY, runner.sim) ?? null;
    store.set({ selection: pick });
  };

  return (
    <div ref={wrap} className="field3d">
      <canvas ref={canvas} onClick={onClick} aria-label="3D field view — drag to rotate, scroll to zoom, right-drag to pan, click to inspect" />
    </div>
  );
}

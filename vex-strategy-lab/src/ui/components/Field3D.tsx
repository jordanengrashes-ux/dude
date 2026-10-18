import { useEffect, useRef, useState } from 'react';
import { FieldScene } from '../three/FieldScene';
import { runner } from '../simRunner';
import { localInput } from '../input';
import { team } from '../../net/session';
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
  const [locked, setLocked] = useState(false);
  const [driving, setDriving] = useState(false);

  useEffect(() => {
    const sc = new FieldScene(canvas.current!);
    sceneRef.current = sc;
    // ?debug exposes the scene for automated screenshots / console inspection
    if (new URLSearchParams(window.location.search).has('debug')) Object.assign(window as object, { __vexScene: sc, __vexRunner: runner, __vexTeam: team.session, __vexStore: store });
    const ro = new ResizeObserver(() => sc.resize(wrap.current!.clientWidth, wrap.current!.clientHeight));
    ro.observe(wrap.current!);
    let raf = 0;
    let last = performance.now();
    let trailTick = 0;
    let robotSet: unknown[] = [];
    let following: string | null = null;
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      localInput.pollGamepad();
      // a team-mode guest draws the host's interpolated snapshots instead of local physics
      const guest = team.role === 'guest';
      if (!guest) runner.frame(dt);
      const frame = guest ? (team.session?.frameAt() ?? null) : runner.sim ? runner.sim.sceneFrame() : null;
      if (frame) {
        const cfgs = frame.robots.map((r) => r.cfg);
        if (cfgs.length !== robotSet.length || cfgs.some((c, i) => c !== robotSet[i])) {
          sc.resetRobots();
          robotSet = cfgs;
        }
        sc.sync(frame, store.get().selection);
        // 3rd person, locked on the robot you drive (back to the overview when you stop)
        const mine = drivingSlot();
        if (mine !== following) {
          following = mine;
          sc.setFollow(mine);
          setDriving(!!mine);
          if (mine) store.set({ camera: 'chase' });
          else {
            sc.unlockPointer();
            if (store.get().camera === 'chase') store.set({ camera: 'iso' });
          }
        }
        if (trailTick++ % 10 === 0) sc.setTrails(frame.robots.map((r) => ({ id: r.id, alliance: r.alliance, pts: r.trail })));
      }
      sc.render();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    localInput.onViewReset = () => sc.resetView();
    localInput.onToggleFirstPerson = () => sc.toggleFirstPerson();
    localInput.onCameraStick = (x, y) => sc.orbitBy(x, y);
    const lockChange = () => {
      setLocked(sc.pointerLocked);
      if (!sc.pointerLocked) localInput.setMouseIntake(false);
    };
    document.addEventListener('pointerlockchange', lockChange);
    // the right mouse button runs the rollers in while it is held (driving)
    const up = (e: PointerEvent) => e.button === 2 && localInput.setMouseIntake(false);
    window.addEventListener('pointerup', up);
    // Browsers pause animation frames in hidden tabs; a team-mode host keeps the
    // match running from (throttled, ~1 Hz) timers so the guests' game goes on.
    let lastBg = performance.now();
    const bg = setInterval(() => {
      const now = performance.now();
      if (document.hidden && team.role === 'host') runner.frame((now - lastBg) / 1000, 1.0);
      lastBg = now;
    }, 250);
    return () => {
      document.removeEventListener('pointerlockchange', lockChange);
      window.removeEventListener('pointerup', up);
      sc.unlockPointer();
      clearInterval(bg);
      cancelAnimationFrame(raf);
      localInput.onViewReset = localInput.onToggleFirstPerson = null;
      localInput.onCameraStick = null;
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
    // the end of a drag (looking around / orbiting) is not a click
    if (sceneRef.current?.wasDrag()) return;
    // driving: the first click locks the cursor to the view (mouse look); then left
    // click opens / closes the claw. Otherwise a click inspects.
    if (drivingSlot()) {
      if (!sceneRef.current?.pointerLocked && sceneRef.current?.lockPointer()) return;
      localInput.toggleClaw();
      return;
    }
    const pick = sceneRef.current?.pick(e.clientX, e.clientY) ?? null;
    store.set({ selection: pick });
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2 && drivingSlot()) localInput.setMouseIntake(true);
  };

  return (
    <div ref={wrap} className="field3d">
      <canvas
        ref={canvas}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onContextMenu={(e) => drivingSlot() && e.preventDefault()}
        aria-label="3D field view — drag to rotate, scroll to zoom, right-drag to pan, click to inspect; while driving, click locks the mouse for looking around, then click opens and closes the claw and the right button runs the rollers in"
      />
      {driving && (
        <div className={`lock-hint${locked ? ' on' : ''}`}>
          {locked ? 'Mouse looks around · left click: claw · hold right button: rollers in · Esc frees the cursor' : 'Click the field to lock the mouse for looking around'}
        </div>
      )}
    </div>
  );
}

/** The robot this player drives: a team-mode guest's slot, or the local driver's. */
function drivingSlot(): string | null {
  return team.role === 'guest' ? (team.session?.mySlot() ?? null) : runner.localSlot;
}

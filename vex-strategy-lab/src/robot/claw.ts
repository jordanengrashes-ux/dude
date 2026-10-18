/**
 * The roller claw (carriage frame, inches; x forward from the holder axis, z to the
 * robot's right): two jaws hinged behind the holder, each with a vertical shaft of
 * three roller wheels at its tip. Run inward, the rollers pull a piece at the jaws
 * in between them and grip it; run outward, they push it back out the front.
 */
export const CLAW = {
  /** Shaft position when closed (in front of the holder axis, either side). */
  shaftX: 0.9,
  shaftZ: 2.2,
  /** Roller wheel radius and the three wheels' heights above the holder bottom. */
  rollerR: 0.6,
  rollerHeights: [0.9, 2.6, 4.3],
  /** Jaw hinge (behind the holder axis, either side). */
  hingeX: -2.4,
  hingeZ: 1.75,
  /** Roller surface speed (in/s): how fast a piece is pulled in and moved within the claw. */
  surfaceSpeed: 20,
  /** How fast the rollers push a piece out (in/s). */
  outSpeed: 15,
} as const;

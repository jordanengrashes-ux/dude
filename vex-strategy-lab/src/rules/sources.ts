/**
 * Source registry for every implemented rule.
 *
 * IMPORTANT — how these were checked (2026-10-17):
 * The build environment could not open manuals.vex.com, events.vex.com or
 * vexrobotics.com directly (DNS/proxy blocked). Rule content was gathered through
 * web-search result extracts of those official pages. Each rule therefore carries a
 * `verification` level so nobody mistakes an extract for a first-hand reading of
 * the PDF. Re-verify against the current manual before relying on any number.
 */
export type Verification =
  /** Value appears in an extract of an official VEX/RECF page (manual, Q&A, game page). */
  | 'official-extract'
  /** Value appears only in secondary sources (team summaries, retailer guides, forum). */
  | 'secondary'
  /** Official and secondary sources disagree; the implemented value is the documented choice. */
  | 'conflicting'
  /** Not found in any source; value is a labeled modeling assumption and is user-editable. */
  | 'assumption';

export interface Source {
  id: string;
  title: string;
  url: string;
  publisher: 'VEX Robotics' | 'REC Foundation' | 'Third party';
  official: boolean;
  /** Manual version the source refers to, when known. */
  version?: string;
  accessed: string;
  accessMethod: 'web-search extract' | 'direct';
}

export const LAST_CHECKED = '2026-10-17';

export const SOURCES: Record<string, Source> = {
  manual: {
    id: 'manual',
    title: 'V5RC Override Game Manual (online), v2.1',
    url: 'https://manuals.vex.com/v5/override/v2.1/',
    publisher: 'VEX Robotics',
    official: true,
    version: '2.1 (released 2026-10-08 per VEX game page)',
    accessed: LAST_CHECKED,
    accessMethod: 'web-search extract',
  },
  manualOnline: {
    id: 'manualOnline',
    title: 'V5RC Override Game Manual — link.vex.com/override-online',
    url: 'https://link.vex.com/override-online',
    publisher: 'VEX Robotics',
    official: true,
    version: '2.x',
    accessed: LAST_CHECKED,
    accessMethod: 'web-search extract',
  },
  manualPdf11: {
    id: 'manualPdf11',
    title: 'V5RC Override Game Manual v1.1 (PDF with the Appendix A field drawings; marked obsolete)',
    url: 'https://content.vexrobotics.com/docs/2026-2027/override/files/override-v1.1-obs.pdf',
    publisher: 'VEX Robotics',
    official: true,
    version: '1.1',
    accessed: '2026-10-18',
    accessMethod: 'direct', // downloaded PDF; dimensions measured on the drawings
  },
  appendixA: {
    id: 'appendixA',
    title: 'Appendix A — Field Overview, VEX V5 Override v2.1',
    url: 'https://manuals.vex.com/v5/override/v2.1/appendix-a/',
    publisher: 'VEX Robotics',
    official: true,
    version: '2.1',
    accessed: LAST_CHECKED,
    accessMethod: 'web-search extract',
  },
  gamePage: {
    id: 'gamePage',
    title: 'VEX V5 Override: Game Manual & Rules (game page)',
    url: 'https://www.vexrobotics.com/v5/competition/vrc-current-game',
    publisher: 'VEX Robotics',
    official: true,
    version: '2.1',
    accessed: LAST_CHECKED,
    accessMethod: 'web-search extract',
  },
  qa: {
    id: 'qa',
    title: 'Q&A: VEX V5 Robotics Competition 2026-2027: Override',
    url: 'https://events.vex.com/faqs/51/printable',
    publisher: 'VEX Robotics',
    official: true,
    accessed: LAST_CHECKED,
    accessMethod: 'web-search extract',
  },
  qa3188: {
    id: 'qa3188',
    title: 'Q&A 3188 — Midfield ownership only evaluated at end of Match',
    url: 'https://events.vex.com/faqs/51/printable',
    publisher: 'VEX Robotics',
    official: true,
    accessed: LAST_CHECKED,
    accessMethod: 'web-search extract',
  },
  vexAi: {
    id: 'vexAi',
    title: 'Section 7 — VEX AI Robotics Competition, Override v2.1 (used only for contrast)',
    url: 'https://manuals.vex.com/v5/override/v2.1/vex-ai/',
    publisher: 'VEX Robotics',
    official: true,
    version: '2.1',
    accessed: LAST_CHECKED,
    accessMethod: 'web-search extract',
  },
  atlantaHobby: {
    id: 'atlantaHobby',
    title: 'VEX V5 Override 2026-27: Scoring and Robot Design Guide (cites manual v2.0)',
    url: 'https://www.atlantahobby.com/blogs/robotics/vex-v5-override-game-breakdown-scoring',
    publisher: 'Third party',
    official: false,
    version: '2.0 (as cited)',
    accessed: LAST_CHECKED,
    accessMethod: 'web-search extract',
  },
  spartan: {
    id: 'spartan',
    title: 'Override v1.1 Manual Summary (Spartan Design)',
    url: 'https://spartandesignrobotics.org/override-manual-summary',
    publisher: 'Third party',
    official: false,
    version: '1.1 (as cited)',
    accessed: LAST_CHECKED,
    accessMethod: 'web-search extract',
  },
  forumDims: {
    id: 'forumDims',
    title: 'VEX Forum — Override dimensions',
    url: 'https://www.vexforum.com/t/override-dimensions/145928',
    publisher: 'Third party',
    official: false,
    accessed: LAST_CHECKED,
    accessMethod: 'web-search extract',
  },
  perimeterQA: {
    id: 'perimeterQA',
    title: 'V5RC Q&A — field perimeter wall height (11.5" min to 12.5" max)',
    url: 'https://events.vex.com/V5RC/2024-2025/QA/2360',
    publisher: 'VEX Robotics',
    official: true,
    accessed: LAST_CHECKED,
    accessMethod: 'web-search extract',
  },
  manualsPlus: {
    id: 'manualsPlus',
    title: 'Manuals+ copy of the Override game manual (aggregator)',
    url: 'https://manuals.plus/vex-robotics/v5-robotics-competition-override-game-manual',
    publisher: 'Third party',
    official: false,
    accessed: LAST_CHECKED,
    accessMethod: 'web-search extract',
  },
  pushBackTiles: {
    id: 'pushBackTiles',
    title: 'VEX VR playground field details (600 mm tiles, same field system)',
    url: 'https://api.vex.com/vr/home/playgrounds/v5rc_push_back/field_details.html',
    publisher: 'VEX Robotics',
    official: true,
    accessed: LAST_CHECKED,
    accessMethod: 'web-search extract',
  },
  v5Motor: {
    id: 'v5Motor',
    title: 'V5 Smart Motor (11 W) published specs: 100/200/600 rpm cartridges, ~2.1 N·m stall @100 rpm',
    url: 'https://www.vexrobotics.com/276-4840.html',
    publisher: 'VEX Robotics',
    official: true,
    accessed: 'model knowledge (not re-fetched)',
    accessMethod: 'web-search extract',
  },
};

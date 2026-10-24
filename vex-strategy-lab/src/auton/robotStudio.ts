/**
 * Robot Studio (the online PROS editor). Its API only answers its own site, so code goes
 * there through the clipboard: copy here, open the project there, paste.
 */

export const ROBOT_STUDIO = 'https://robotstudio.ct839.com/';

/** A Robot Studio project link (robotstudio.ct839.com/p/<id>, with or without https://), tidied; null if it isn't one. */
export function robotStudioProject(link: string): string | null {
  const s = link.trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    const m = /^\/p\/([^/]+)/.exec(u.pathname);
    return u.host === new URL(ROBOT_STUDIO).host && m ? `${ROBOT_STUDIO}p/${m[1]}` : null;
  } catch {
    return null;
  }
}

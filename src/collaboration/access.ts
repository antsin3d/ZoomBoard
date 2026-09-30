// Store-level guards supplement disabled controls; remote input is separately
// authorized by the host. This is an application policy, not copy protection.
let editable = true;
let copyable = true;
let applyingRemote = false;

export const canEditBoard = () => editable || applyingRemote;
export const canCopyBoard = () => copyable;
export function setBoardAccess(edit: boolean, copy: boolean): void {
  editable = edit;
  copyable = copy;
}
export function withRemoteBoard<T>(apply: () => T): T {
  const previous = applyingRemote;
  applyingRemote = true;
  try { return apply(); } finally { applyingRemote = previous; }
}

export interface DidFailLoadEvent {
  errorCode: number;
  validatedURL: string;
  isMainFrame: boolean;
}

/** Electron `did-fail-load` callback argument order. */
export function parseDidFailLoad(
  _event: unknown,
  errorCode: number,
  _errorDescription: string,
  validatedURL: string,
  isMainFrame: boolean,
): DidFailLoadEvent {
  return { errorCode, validatedURL, isMainFrame };
}

export function isMainFrameLoadFailure(event: DidFailLoadEvent): boolean {
  return event.isMainFrame === true;
}

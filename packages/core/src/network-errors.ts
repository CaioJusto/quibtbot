const TRANSIENT_NETWORK_MESSAGE =
  /network request failed|failed to fetch|fetch failed|networkerror|load failed|network connection was lost|connection (?:reset|closed|lost)|\berr_[a-z_]+|demorou demais|timed? ?out|aborted|conexão falhou|não foi possível alcançar|econnrefused|econnreset|enotfound|eai_again|socket hang up|http 5\d\d/i;

/** Network failures have different native wording on iOS, Android, browsers and Node. */
export function isTransientNetworkMessage(message: string): boolean {
  return TRANSIENT_NETWORK_MESSAGE.test(message);
}

export function isTransientNetworkFailure(error: unknown): error is Error {
  return error instanceof Error && isTransientNetworkMessage(error.message);
}

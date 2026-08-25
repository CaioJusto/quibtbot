/**
 * Gravação da tela do bot.
 *
 * Diferente do print, aqui não dá para improvisar: vídeo precisa de codec, e quem tem é o
 * ffmpeg. Ele entrou na imagem do computador — um computador criado antes disso segue com
 * a imagem antiga, então o comando confere se o ffmpeg está lá e diz o que fazer quando
 * não está, em vez de falhar calado.
 */

/** Gravar e codificar precisa caber no tempo de um comando (5 min por padrão), com folga. */
export const MAX_RECORDING_SECONDS = 60;
export const DEFAULT_RECORDING_SECONDS = 10;

export function boundedRecordingSeconds(requested: unknown): number {
  const asked = Number(requested);
  if (!Number.isFinite(asked) || asked <= 0) return DEFAULT_RECORDING_SECONDS;
  return Math.min(Math.round(asked), MAX_RECORDING_SECONDS);
}

export const FFMPEG_MISSING = "ffmpeg-missing";

/**
 * `ultrafast` e `yuv420p`: a gravação tem de terminar perto do tempo real e o arquivo
 * precisa abrir em qualquer lugar. Sem áudio de propósito — a imagem não tem som.
 */
export function recordScreenCommand(target: string, seconds: number): string[] {
  return [
    "bash",
    "-lc",
    `set -e; command -v ffmpeg >/dev/null 2>&1 || { echo "${FFMPEG_MISSING}" >&2; exit 3; }; ` +
      `ffmpeg -hide_banner -loglevel error -y -f x11grab -framerate 15 ` +
      `-video_size "$(xdotool getdisplaygeometry --shell | sed -n 's/WIDTH=//p' | tr -d '\\n')x$(xdotool getdisplaygeometry --shell | sed -n 's/HEIGHT=//p' | tr -d '\\n')" ` +
      `-i "\${DISPLAY:-:1}" -t "$2" -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$1"`,
    "quibt-record-screen",
    target,
    String(seconds),
  ];
}

export function recordingPath(stamp: number): string {
  return `/tmp/quibt-gravacao-${stamp}.mp4`;
}

export function missingFfmpegMessage(): string {
  return (
    "Este computador ainda não tem ffmpeg. Rode `pnpm sandbox:build` para reconstruir a " +
    "imagem e recrie o computador do bot; computadores criados antes disso seguem na imagem antiga."
  );
}

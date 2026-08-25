import type { MobileRoutine } from "./api";

export function withoutRoutine(
  routines: readonly MobileRoutine[],
  routineId: string,
): MobileRoutine[] {
  return routines.filter((routine) => routine.id !== routineId);
}

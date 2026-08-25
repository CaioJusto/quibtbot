import { useCallback, useEffect, useState } from "react";
import { Pressable, Switch, Text, TextInput, View } from "react-native";
import { type MobileRoutine, rpc } from "./api";
import { COLORS } from "./design-system";
import { AppSymbol, showNativeSheet } from "./native";
import { withoutRoutine } from "./routines-state";

export type RoutineFreq = "hourly" | "daily" | "weekly";

const FREQS: Array<{ id: RoutineFreq; label: string }> = [
  { id: "hourly", label: "Toda hora" },
  { id: "daily", label: "Todo dia" },
  { id: "weekly", label: "Toda semana" },
];

const HOURS = [6, 9, 12, 15, 18, 21];

/** Tiny local mirror of the web's cron presets: hourly, daily and weekly (Mondays). */
export function cronFromSimplePreset(freq: RoutineFreq, hour: number): string {
  if (freq === "hourly") return "0 * * * *";
  if (freq === "weekly") return `0 ${hour} * * 1`;
  return `0 ${hour} * * *`;
}

/** Best-effort human label for the cron strings this app writes; falls back to the raw cron. */
export function describeCron(cron: string): string {
  if (cron === "0 * * * *") return "Toda hora";
  const daily = /^0 (\d{1,2}) \* \* \*$/.exec(cron);
  if (daily) return `Todo dia às ${String(daily[1]).padStart(2, "0")}:00`;
  const weekly = /^0 (\d{1,2}) \* \* 1$/.exec(cron);
  if (weekly) return `Toda segunda às ${String(weekly[1]).padStart(2, "0")}:00`;
  return cron;
}

function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The "Routines" settings card, shared by bot settings and group settings.
 * Pass exactly one of botId / groupId — routines are created against that owner.
 */
export function RoutinesSection({
  botId,
  groupId,
  localOnly = false,
}: {
  botId?: string;
  groupId?: string;
  localOnly?: boolean;
}) {
  const [routines, setRoutines] = useState<MobileRoutine[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [freq, setFreq] = useState<RoutineFreq>("daily");
  const [hour, setHour] = useState(9);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const owner = botId ? { botId } : groupId ? { groupId } : null;

  const load = useCallback(async () => {
    if (!owner || localOnly) return;
    try {
      const list = await rpc<MobileRoutine[]>("routines/list", owner);
      setRoutines(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível carregar as rotinas");
    }
  }, [botId, groupId, localOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    if (!owner || !name.trim() || !prompt.trim() || busy) return;
    setError(null);
    setBusy(true);
    if (localOnly) {
      setRoutines((current) => [
        ...current,
        {
          id: `demo:routine:${Date.now()}`,
          name: name.trim(),
          prompt: prompt.trim(),
          cron: cronFromSimplePreset(freq, hour),
          timezone: deviceTimezone(),
          notify: true,
          active: true,
        },
      ]);
      setName("");
      setPrompt("");
      setShowForm(false);
      setBusy(false);
      return;
    }
    try {
      await rpc("routines/create", {
        ...owner,
        name: name.trim(),
        prompt: prompt.trim(),
        cron: cronFromSimplePreset(freq, hour),
        timezone: deviceTimezone(),
        notify: true,
        active: true,
      });
      setName("");
      setPrompt("");
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível criar a rotina");
    } finally {
      setBusy(false);
    }
  }

  function toggle(routine: MobileRoutine, active: boolean) {
    setRoutines((prev) => prev.map((r) => (r.id === routine.id ? { ...r, active } : r)));
    if (localOnly) return;
    setError(null);
    void rpc("routines/update", { routineId: routine.id, active }).catch((err: unknown) => {
      setRoutines((prev) =>
        prev.map((row) => (row.id === routine.id ? { ...row, active: routine.active } : row)),
      );
      setError(err instanceof Error ? err.message : "Não foi possível atualizar a rotina");
    });
  }

  function remove(routine: MobileRoutine) {
    showNativeSheet({
      title: "Apagar rotina",
      message: `Apagar "${routine.name}"?`,
      actions: [
        {
          label: "Apagar",
          destructive: true,
          onPress: () => {
            const previous = routines;
            setRoutines(withoutRoutine(previous, routine.id));
            if (localOnly) return;
            setError(null);
            void rpc("routines/remove", { routineId: routine.id }).catch((err: unknown) => {
              setRoutines(previous);
              setError(err instanceof Error ? err.message : "Não foi possível apagar a rotina");
            });
          },
        },
      ],
    });
  }

  return (
    <View style={{ marginTop: 26 }}>
      <Text
        style={{
          color: COLORS.tertiary,
          fontSize: 16,
          fontWeight: "600",
          marginBottom: 10,
          marginLeft: 42,
        }}
      >
        Rotinas
      </Text>
      <View
        style={{
          backgroundColor: COLORS.card,
          borderRadius: 16,
          overflow: "hidden",
          marginHorizontal: 24,
        }}
      >
        {routines.length === 0 && !showForm ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 18, paddingBottom: 12 }}>
            <Text style={{ color: COLORS.tertiary, fontSize: 17 }}>Nenhuma rotina ainda</Text>
          </View>
        ) : null}
        {routines.map((routine) => (
          <View
            key={routine.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 18,
              minHeight: 66,
              gap: 12,
            }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                numberOfLines={1}
                style={{ color: COLORS.primary, fontSize: 18, fontWeight: "600" }}
              >
                {routine.name}
              </Text>
              <Text
                numberOfLines={1}
                style={{ color: COLORS.secondary, fontSize: 15, marginTop: 2 }}
              >
                {describeCron(routine.cron)}
              </Text>
            </View>
            <Switch
              value={routine.active}
              onValueChange={(value) => toggle(routine, value)}
              trackColor={{ true: COLORS.green }}
            />
            <Pressable
              accessibilityLabel="Apagar rotina"
              onPress={() => remove(routine)}
              hitSlop={8}
            >
              <AppSymbol name="xmark" size={16} color={COLORS.secondary} />
            </Pressable>
          </View>
        ))}
        {showForm ? (
          <View style={{ padding: 16, gap: 10 }}>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Nome da rotina"
              placeholderTextColor={COLORS.tertiary}
              style={{
                backgroundColor: COLORS.cardRaised,
                borderRadius: 10,
                padding: 12,
                color: COLORS.primary,
              }}
            />
            <TextInput
              value={prompt}
              onChangeText={setPrompt}
              placeholder="O que deve acontecer?"
              placeholderTextColor={COLORS.tertiary}
              multiline
              style={{
                backgroundColor: COLORS.cardRaised,
                borderRadius: 10,
                padding: 12,
                minHeight: 64,
                color: COLORS.primary,
              }}
            />
            <View style={{ flexDirection: "row", gap: 8 }}>
              {FREQS.map((option) => (
                <Pressable
                  key={option.id}
                  onPress={() => setFreq(option.id)}
                  style={{
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    borderRadius: 999,
                    backgroundColor: freq === option.id ? COLORS.primaryStrong : COLORS.card,
                  }}
                >
                  <Text
                    style={{
                      color: freq === option.id ? COLORS.background : COLORS.primary,
                      fontSize: 14,
                    }}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            {freq !== "hourly" ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {HOURS.map((option) => (
                  <Pressable
                    key={option}
                    onPress={() => setHour(option)}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderRadius: 999,
                      backgroundColor: hour === option ? COLORS.primaryStrong : COLORS.card,
                    }}
                  >
                    <Text
                      style={{
                        color: hour === option ? COLORS.background : COLORS.primary,
                        fontSize: 13,
                      }}
                    >
                      {String(option).padStart(2, "0")}:00
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {error ? <Text style={{ color: COLORS.red, fontSize: 13 }}>{error}</Text> : null}
            <Pressable
              onPress={() => void create()}
              disabled={busy || !name.trim() || !prompt.trim()}
              style={{
                backgroundColor: COLORS.primaryStrong,
                borderRadius: 999,
                padding: 13,
                alignItems: "center",
                opacity: !busy && name.trim() && prompt.trim() ? 1 : 0.5,
              }}
            >
              <Text style={{ color: COLORS.background, fontSize: 15, fontWeight: "600" }}>
                {busy ? "Criando…" : "Criar rotina"}
              </Text>
            </Pressable>
          </View>
        ) : null}
        <Pressable
          onPress={() => setShowForm((value) => !value)}
          style={{ paddingHorizontal: 18, minHeight: 58, justifyContent: "center" }}
        >
          <Text style={{ color: COLORS.blue, fontSize: 16, fontWeight: "600" }}>
            {showForm ? "Cancelar" : "+  Adicionar rotina"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

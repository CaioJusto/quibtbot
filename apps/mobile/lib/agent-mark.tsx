import {
  canonicalizeShape,
  type MascotColorKey,
  type MascotFamily,
  mascotFamilyFor,
  nearestMascotColorKey,
  resolveAppearance,
} from "@quibt/ui-tokens";
import { useEffect, useRef } from "react";
import { Animated, Image, type ImageSourcePropType, View } from "react-native";

const MASCOT_ASSETS = {
  blob: {
    white: require("../assets/mascot-blob-white.png"),
    navy: require("../assets/mascot-blob-navy.png"),
    strobi: require("../assets/mascot-blob-strobi.png"),
    freddy: require("../assets/mascot-blob-freddy.png"),
    citrus: require("../assets/mascot-blob-citrus.png"),
    nova: require("../assets/mascot-blob-nova.png"),
    grok: require("../assets/mascot-blob-grok.png"),
    sunee: require("../assets/mascot-blob-sunee.png"),
    kirby: require("../assets/mascot-blob-kirby.png"),
    cloudee: require("../assets/mascot-blob-cloudee.png"),
    cubee: require("../assets/mascot-blob-cubee.png"),
    onee: require("../assets/mascot-blob-onee.png"),
  },
  cube: {
    white: require("../assets/mascot-cube-white.png"),
    navy: require("../assets/mascot-cube-navy.png"),
    strobi: require("../assets/mascot-cube-strobi.png"),
    freddy: require("../assets/mascot-cube-freddy.png"),
    citrus: require("../assets/mascot-cube-citrus.png"),
    nova: require("../assets/mascot-cube-nova.png"),
    grok: require("../assets/mascot-cube-grok.png"),
    sunee: require("../assets/mascot-cube-sunee.png"),
    kirby: require("../assets/mascot-cube-kirby.png"),
    cloudee: require("../assets/mascot-cube-cloudee.png"),
    cubee: require("../assets/mascot-cube-cubee.png"),
    onee: require("../assets/mascot-cube-onee.png"),
  },
  drop: {
    white: require("../assets/mascot-drop-white.png"),
    navy: require("../assets/mascot-drop-navy.png"),
    strobi: require("../assets/mascot-drop-strobi.png"),
    freddy: require("../assets/mascot-drop-freddy.png"),
    citrus: require("../assets/mascot-drop-citrus.png"),
    nova: require("../assets/mascot-drop-nova.png"),
    grok: require("../assets/mascot-drop-grok.png"),
    sunee: require("../assets/mascot-drop-sunee.png"),
    kirby: require("../assets/mascot-drop-kirby.png"),
    cloudee: require("../assets/mascot-drop-cloudee.png"),
    cubee: require("../assets/mascot-drop-cubee.png"),
    onee: require("../assets/mascot-drop-onee.png"),
  },
  orb: {
    white: require("../assets/mascot-orb-white.png"),
    navy: require("../assets/mascot-orb-navy.png"),
    strobi: require("../assets/mascot-orb-strobi.png"),
    freddy: require("../assets/mascot-orb-freddy.png"),
    citrus: require("../assets/mascot-orb-citrus.png"),
    nova: require("../assets/mascot-orb-nova.png"),
    grok: require("../assets/mascot-orb-grok.png"),
    sunee: require("../assets/mascot-orb-sunee.png"),
    kirby: require("../assets/mascot-orb-kirby.png"),
    cloudee: require("../assets/mascot-orb-cloudee.png"),
    cubee: require("../assets/mascot-orb-cubee.png"),
    onee: require("../assets/mascot-orb-onee.png"),
  },
} satisfies Record<MascotFamily, Record<MascotColorKey, ImageSourcePropType>>;

/** Todas as artes de mascote, para o pré-carregamento na abertura do app. */
export function mascotSources(): ImageSourcePropType[] {
  return Object.values(MASCOT_ASSETS).flatMap((family) => Object.values(family));
}

function sourceForAppearance(shape: string, color: string): ImageSourcePropType {
  return MASCOT_ASSETS[mascotFamilyFor(shape)][nearestMascotColorKey(color)];
}

/**
 * Every bot shares the same Quibt mascot language and eyes. Generated body-color
 * materials and shape families keep agents distinct without the old flat icon set.
 */
export function AgentMark(props: {
  color: string;
  shape?: string | null;
  size?: number;
  online?: boolean;
  /** Verde: trabalhando. Azul: terminou e é a pessoa quem falta (resposta, aprovação). */
  presence?: "working" | "attention" | null;
  title?: string;
  animated?: boolean;
}) {
  const size = props.size ?? 38;
  const developmentBundle = typeof __DEV__ !== "undefined" && __DEV__;
  const animated = props.animated ?? (size >= 100 && !developmentBundle);
  const appearance = resolveAppearance(props.color, props.shape);
  const fill = appearance.color;
  const shape = canonicalizeShape(appearance.shape);
  const source = sourceForAppearance(shape, fill);

  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {animated ? (
        <AnimatedMascotBody size={size} source={source} />
      ) : (
        <Image source={source} resizeMode="contain" style={{ width: size, height: size }} />
      )}
      {props.presence || props.online ? (
        <View
          style={{
            position: "absolute",
            right: Math.max(1, size * 0.03),
            bottom: Math.max(0, size * 0.01),
            width: Math.max(10, size * 0.19),
            height: Math.max(10, size * 0.19),
            borderRadius: 99,
            backgroundColor: props.presence === "attention" ? "#3C82F6" : "#30D158",
            borderWidth: 2,
            borderColor: "#000",
          }}
        />
      ) : null}
    </View>
  );
}

function AnimatedMascotBody({ size, source }: { size: number; source: ImageSourcePropType }) {
  const phase = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(phase, {
        toValue: 1,
        duration: 2300,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [phase]);

  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        transform: [
          {
            translateY: phase.interpolate({
              inputRange: [0, 0.5, 1],
              outputRange: [0, -size * 0.045, 0],
            }),
          },
          {
            scale: phase.interpolate({
              inputRange: [0, 0.5, 1],
              outputRange: [1, 1.035, 1],
            }),
          },
        ],
      }}
    >
      <Image source={source} resizeMode="contain" style={{ width: size, height: size }} />
    </Animated.View>
  );
}

/** Composite avatar for a bot group: a cluster of up to three member marks. */
export function GroupMark(props: {
  members: Array<{ id: string; color: string; shape?: string | null }>;
  size?: number;
}) {
  const size = props.size ?? 48;
  const shown = props.members.slice(0, 3);
  if (shown.length <= 1) {
    const member = shown[0];
    return (
      <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
        {member ? <AgentMark color={member.color} shape={member.shape} size={size * 0.88} /> : null}
      </View>
    );
  }
  const mark = size * (shown.length === 2 ? 0.56 : 0.5);
  return (
    <View style={{ width: size, height: size }}>
      {shown.map((member, i) => {
        const pos = clusterOffset(shown.length, i, size, mark);
        return (
          <View key={member.id} style={{ position: "absolute", left: pos.x, top: pos.y }}>
            <AgentMark color={member.color} shape={member.shape} size={mark} />
          </View>
        );
      })}
    </View>
  );
}

function clusterOffset(count: number, index: number, size: number, mark: number) {
  if (count === 2) {
    const y = (size - mark) / 2;
    return index === 0 ? { x: 0, y } : { x: size - mark, y };
  }
  if (index === 0) return { x: 0, y: 0 };
  if (index === 1) return { x: size - mark, y: 0 };
  return { x: (size - mark) / 2, y: size - mark };
}

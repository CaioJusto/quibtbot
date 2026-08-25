import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

/** Lado da foto de perfil guardada: cabe num data URL pequeno e fica nítida em 2x. */
export const AVATAR_SIDE = 256;

export type AvatarSource = "library" | "camera";

/**
 * Escolhe (ou tira) uma foto e a devolve já quadrada, em 256 px e como data URL JPEG —
 * é assim que ela viaja para o servidor (`update-user.image`) e volta nas sessões. Sem
 * reduzir, uma foto de 4000 px viraria um data URL de centenas de KB em cada get-session.
 * Devolve `null` quando a pessoa cancela ou nega a permissão.
 */
export async function pickAvatar(source: AvatarSource): Promise<string | null> {
  const permission =
    source === "camera"
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return null;
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.9,
  };
  const result =
    source === "camera"
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  const shrunk = await ImageManipulator.manipulateAsync(
    asset.uri,
    [{ resize: { width: AVATAR_SIDE, height: AVATAR_SIDE } }],
    { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG, base64: true },
  );
  return shrunk.base64 ? `data:image/jpeg;base64,${shrunk.base64}` : null;
}

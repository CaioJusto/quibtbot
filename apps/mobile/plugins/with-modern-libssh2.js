const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

/**
 * Faz o app iOS linkar a libssh2 moderna em vez da que vem no pod NMSSH.
 *
 * O NMSSH 2.3.1 (2018) embute a libssh2 1.8.0, que só conhece chaves de host
 * `ssh-rsa` (SHA-1) e `ssh-dss`. O OpenSSH 8.8+ aposentou as duas por padrão, então
 * contra um servidor atual não sobra algoritmo em comum e o aperto de mão morre antes
 * de qualquer senha: era por isso que "Instalar na VPS" nunca conectava pelo iPhone.
 *
 * `apps/mobile/scripts/build-ios-libssh2.sh` constrói libssh2 1.11 + OpenSSL 3 para
 * cada SDK. Este plugin põe esses diretórios na frente dos do pod, por plataforma —
 * `$(PLATFORM_NAME)` resolve para iphoneos ou iphonesimulator na hora da compilação,
 * então o mesmo `pod install` serve para aparelho e simulador.
 */

const MARKER = "# quibt:modern-libssh2";

const POST_INSTALL = `
    ${MARKER}
    # Ver apps/mobile/plugins/with-modern-libssh2.js. Sem estes diretórios o app
    # linkaria a libssh2 1.8 do NMSSH, que não fala com servidor SSH atual.
    quibt_ssh_root = File.expand_path('../ios-libssh2', __dir__)
    unless Dir.exist?(File.join(quibt_ssh_root, 'iphoneos')) || Dir.exist?(File.join(quibt_ssh_root, 'iphonesimulator'))
      raise "libssh2 moderna ausente. Rode: apps/mobile/scripts/build-ios-libssh2.sh"
    end
    quibt_ssh_lib = File.join(quibt_ssh_root, '$(PLATFORM_NAME)', 'lib')
    quibt_ssh_include = File.join(quibt_ssh_root, '$(PLATFORM_NAME)', 'include')
    quibt_projects = [installer.pods_project] + installer.aggregate_targets.map { |t| t.user_project }
    quibt_projects.compact.uniq.each do |project|
      project.targets.each do |target|
        target.build_configurations.each do |config|
          # Na frente do herdado: o linker fica com a primeira libssh2.a que achar, e
          # o diretório do pod continua na lista com a versão velha.
          config.build_settings['LIBRARY_SEARCH_PATHS'] = ['"' + quibt_ssh_lib + '"', '$(inherited)']
          config.build_settings['HEADER_SEARCH_PATHS'] = ['"' + quibt_ssh_include + '"', '$(inherited)']
        end
      end
      project.save
    end
`;

function patchPodfile(contents) {
  if (contents.includes(MARKER)) return contents;
  const anchor = /(\n\s*post_install do \|installer\|\n)/;
  if (anchor.test(contents)) return contents.replace(anchor, `$1${POST_INSTALL}`);
  return `${contents}\npost_install do |installer|\n${POST_INSTALL}end\n`;
}

module.exports = function withModernLibssh2(config) {
  return withDangerousMod(config, [
    "ios",
    (modConfig) => {
      const podfile = path.join(modConfig.modRequest.platformProjectRoot, "Podfile");
      if (fs.existsSync(podfile)) {
        fs.writeFileSync(podfile, patchPodfile(fs.readFileSync(podfile, "utf8")));
      }
      return modConfig;
    },
  ]);
};

module.exports.patchPodfile = patchPodfile;
module.exports.MARKER = MARKER;

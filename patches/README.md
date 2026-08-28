# Dependency patches

`@dylankenneally__react-native-ssh-sftp@1.11.0.patch` adds verified host-key
inspection and connection APIs on Android and iOS, and updates the iOS SSH
runtime used by the native Quibt Bot build.

Metro 0.84.5 no longer depends on `image-size`, so the former parser patch and
its audit exceptions were removed. `packages/testkit/src/dependency-hardening.test.ts`
keeps that absence as a regression guard.

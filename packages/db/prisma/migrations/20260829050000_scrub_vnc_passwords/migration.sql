-- VNC passwords are live Docker transport credentials. Older releases persisted them
-- inside DesktopSession.screenUrl; remove both the legacy query form and the fragment form.
UPDATE "desktop_sessions"
SET "screenUrl" = regexp_replace(
  regexp_replace("screenUrl", '([?#&])password=[^&#]*&?', '\1', 'g'),
  '[?&#]+$',
  '',
  'g'
)
WHERE "screenUrl" ~ '[?#&]password=';

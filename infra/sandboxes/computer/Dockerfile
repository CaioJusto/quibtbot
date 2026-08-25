FROM debian:bookworm-slim
# Set by the release workflow — tagged ghcr.io/quibt/quibt-computer:${RELEASE_VERSION},
# the same version as quibt-supervisor and quibt-stack (scripts/release-version.mjs).
ARG RELEASE_VERSION=0.0.0-dev
LABEL org.opencontainers.image.version=${RELEASE_VERSION}
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    fluxbox \
    xterm \
    xdotool \
    ffmpeg \
    x11-utils \
    x11-xserver-utils \
    xauth \
    novnc \
    websockify \
    python3 \
    ca-certificates \
    procps \
    bash \
    chromium \
    fonts-liberation \
    fonts-dejavu-core \
    dbus-x11 \
    xfwm4 \
    picom \
    python3-xlib \
    tint2 \
    adwaita-icon-theme \
    pcmanfm \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /etc/quibt/fluxbox \
  && printf '%s\n' '#!/bin/sh' 'exec xsetroot -solid "#111113" "$@"' > /usr/bin/fbsetbg \
  && chmod +x /usr/bin/fbsetbg \
  && ln -sfn /bin/true /usr/bin/xmessage \
  && useradd --create-home --uid 1000 --shell /bin/bash quibt
ENV HOME=/home/quibt
WORKDIR /home/quibt
COPY start.sh /usr/local/bin/quibt-computer
COPY quibt-browser /usr/local/bin/quibt-browser
# `xdg-open`, `chromium` e afins, vindos do shell do bot, caem no navegador da sessão
# (quibt-open) — /usr/local/bin vem antes de /usr/bin no PATH de quem executa.
COPY quibt-open /usr/local/bin/quibt-open
COPY chromium-flags /etc/chromium.d/quibt-flags
COPY mimeapps.list /usr/share/applications/mimeapps.list
COPY quibt-session /usr/local/bin/quibt-session
COPY box-chrome /usr/local/bin/box-chrome
COPY quibt-click-pulse /usr/local/bin/quibt-click-pulse
COPY quibt-desktop-bg /usr/local/bin/quibt-desktop-bg
COPY tint2rc /etc/quibt/tint2rc
COPY quibt-browser.desktop quibt-terminal.desktop quibt-files.desktop /usr/share/applications/
COPY fluxbox.init /etc/quibt/fluxbox/init
COPY fluxbox.apps /etc/quibt/fluxbox/apps
COPY fluxbox.menu /etc/quibt/fluxbox/menu
COPY embed.html /usr/share/novnc/embed.html
RUN chmod +x /usr/local/bin/quibt-computer /usr/local/bin/quibt-browser /usr/local/bin/quibt-open /usr/local/bin/quibt-session /usr/local/bin/box-chrome /usr/local/bin/quibt-click-pulse /usr/local/bin/quibt-desktop-bg \
  && for name in xdg-open chromium chromium-browser google-chrome google-chrome-stable x-www-browser sensible-browser; do ln -sfn /usr/local/bin/quibt-open "/usr/local/bin/$name"; done
USER quibt
EXPOSE 6080-6111
CMD ["/usr/local/bin/quibt-computer"]

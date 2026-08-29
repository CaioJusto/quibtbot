FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git python3 python3-pip xvfb x11vnc fluxbox procps \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash quibt
WORKDIR /home/quibt
USER quibt
ENV DISPLAY=:1
CMD ["bash", "-lc", "Xvfb :1 -screen 0 1280x720x24 & sleep 0.5 && fluxbox & x11vnc -display :1 -forever -shared -nopw -listen 0.0.0.0 -rfbport 5900 & sleep infinity"]

FROM bluenviron/mediamtx:1

# Bake config into the image so Coolify does not bind-mount a broken
# host path (it often creates mediamtx.yml as a directory).
COPY mediamtx.yml /mediamtx.yml

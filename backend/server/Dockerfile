## syntax=docker/dockerfile:1.7
ARG RUNTIME_IMAGE=ubuntu:24.04

FROM ${RUNTIME_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/server/build/patrick-im-server /usr/local/bin/patrick-im-server

EXPOSE 5800
CMD ["patrick-im-server"]

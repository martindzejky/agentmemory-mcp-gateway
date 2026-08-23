FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 gateway \
  && useradd --system --uid 10001 --gid gateway --home /app --shell /usr/sbin/nologin gateway

WORKDIR /app
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
COPY scripts/validate-database-path.sh /app/scripts/validate-database-path.sh
RUN chmod 0755 /app/docker-entrypoint.sh

ENTRYPOINT ["/app/docker-entrypoint.sh"]

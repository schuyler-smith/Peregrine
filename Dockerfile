# Peregrine (bird trip planner) - runs the same server.py, listening on the network.
FROM python:3.12-slim

WORKDIR /app
COPY server.py mock_ebird.py ./
COPY web ./web

# Run as a normal user, keep trips/life list/key (data) and eBird answers (cache) in volumes.
RUN useradd --system --uid 10001 birder \
 && mkdir -p data cache \
 && chown -R birder /app/data /app/cache
USER birder

ENV PYTHONUNBUFFERED=1 \
    PEREGRINE_HOST=0.0.0.0 \
    PEREGRINE_PORT=8765
EXPOSE 8765
VOLUME ["/app/data", "/app/cache"]

CMD ["python", "server.py", "--no-browser"]

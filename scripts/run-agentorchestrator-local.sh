#!/usr/bin/env bash
# Boots agentorchestratorsvc locally, wired to discover and call hpoc agents over A2A.
#
# Everything Cashfree-internal is either disabled or replaced by a throwaway local container.
# Nothing here touches your real local MySQL: the orchestrator gets its own MySQL (orch-mysql,
# :3307) and Mongo (orch-mongo, :27017), and Hibernate creates its three tables on first boot.
#
#   docker run -d --name orch-mysql -p 3307:3306 -e MYSQL_ROOT_PASSWORD=orchroot \
#     -e MYSQL_DATABASE=cfadmin -e MYSQL_USER=orch -e MYSQL_PASSWORD=orch mysql:8.4
#   docker run -d --name orch-mongo -p 27017:27017 mongo:7
#   bash scripts/run-agentorchestrator-local.sh
#
# Then:  GET  http://localhost:8085/api/v1/orchestrator/agents   -> the hpoc agent should be listed
#        POST http://localhost:8085/api/v1/orchestrator/classify/v2  (see ai-docs/test/005)
set -euo pipefail

ORCH_DIR="${ORCH_DIR:-$HOME/IdeaProjects/agentorchestratorsvc}"
PORT="${PORT:-8085}"
HPOC_CARDS="${HPOC_CARDS:-http://localhost:3000/relay-workflow-creator/.well-known/agent.json}"
export JAVA_HOME="${JAVA_HOME:-$HOME/Library/Java/JavaVirtualMachines/ms-21.0.9/Contents/Home}"

# Local-only values. None of these are real credentials; the features that read them are
# disabled below, and Spring only needs the placeholders to resolve.
export BEARER_AUTH_TOKEN="Bearer local-orch-token"   # classify/v2 compares Authorization to this
export MYSQL_USERNAME=orch MYSQL_PASSWORD=orch
export BOTPRESS_AUTH_TOKEN=unused FRESHDESK_AUTH_TOKEN=unused GOOGLE_API_KEY=unused
export GSHEET_PRIVATE_KEY=unused OPENAI_API_KEY=unused MINTLIFY_ACCESS_TOKEN=unused
export KAFKA_CONSUMER_SSL_PASSWORD=unused KAFKA_PRODUCER_SSL_PASSWORD=unused UNLEASH_TOKEN=unused
# The built-in Google-ADK agents warm up against Gemini at boot; not needed to reach hpoc.
export ONBOARDING_AGENT_ENABLED=false PAYOUT_AGENT_ENABLED=false ESCALATION_AGENT_ENABLED=false

cd "$ORCH_DIR"
exec "$JAVA_HOME/bin/java" -jar target/agentorchestratorsvc-1.0-SNAPSHOT.jar \
  --server.port="$PORT" \
  '--spring.datasource.url=jdbc:mysql://localhost:3307/cfadmin?useSSL=false&serverTimezone=UTC&allowPublicKeyRetrieval=true' \
  --spring.jpa.hibernate.ddl-auto=update \
  '--spring.data.mongodb.uri=mongodb://localhost:27017/?serverSelectionTimeoutMS=2000' \
  --spring.kafka.consumer.bootstrap-servers=localhost:9092 \
  --spring.kafka.producer.bootstrap-servers=localhost:9092 \
  --spring.kafka.consumer.properties.security.protocol=PLAINTEXT \
  --spring.kafka.producer.properties.security.protocol=PLAINTEXT \
  --spring.kafka.listener.auto-startup=false \
  --unleash.enabled=false \
  --agent.registry.auto-load=true \
  "--agent.registry.base-urls=$HPOC_CARDS"

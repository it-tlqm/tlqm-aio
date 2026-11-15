FROM quay.io/keycloak/keycloak:26.8.2@sha256:3879c623248408de29a5303178b5816c77e8dfef3890c361f8c0bbeaa979ba3b AS upstream
FROM docker.io/library/eclipse-temurin:21.0.13_9-jre-noble@sha256:0d57a8e90c2bb844c5a8e1b2b71e11eff06dad7edcfd803cd21ed4ae203b2515
COPY --from=upstream --chown=10001:0 /opt/keycloak/ /opt/keycloak/
COPY --chown=10001:0 guava-33.7.2-jre.jar /tmp/aio-guava.jar
RUN set -eu; \
    useradd --uid 10001 --gid 0 --home-dir /opt/keycloak --no-create-home --shell /usr/sbin/nologin keycloak; \
    echo 'b530942257fb935f8b2cfaa5f8eb5bd59c555fd8e8d01b8ce98912e077ea606c  /tmp/aio-guava.jar' | sha256sum -c -; \
    mv /tmp/aio-guava.jar /opt/keycloak/lib/lib/main/com.google.guava.guava-33.6.0-jre.jar
ENV KC_RUN_IN_CONTAINER=true
USER 10001:0
RUN /opt/keycloak/bin/kc.sh build --db=postgres
EXPOSE 8080 8443 9000
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]

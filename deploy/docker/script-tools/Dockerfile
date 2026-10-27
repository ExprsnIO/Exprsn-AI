# The script sandbox image for every language except Python, JavaScript/TypeScript and PowerShell (SCRIPT_IMAGE_TOOLS):
# Bash and sh, Perl, Ruby, Tcl, Lua, PHP, gawk, jq and SQLite, plus the command-line tools a shell script reaches for
# (coreutils, grep, sed, diff, bc, miller, xmlstarlet, file, python3). Only what Debian ships: nothing can be fetched at
# run time, as the sandbox has no network. Runs as nobody with a read-only root and a noexec /tmp (see runner.ts).
# Build:  docker build -t exprsn-ai/scripts:1 deploy/docker/script-tools
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash dash coreutils findutils grep sed gawk diffutils bc file tzdata ca-certificates locales-all \
      perl libjson-pp-perl libtext-csv-perl \
      ruby \
      tcl tcllib \
      lua5.4 \
      php-cli php-mbstring php-xml \
      jq sqlite3 miller xmlstarlet \
      python3 \
    && ln -s /usr/bin/lua5.4 /usr/local/bin/lua \
    && rm -rf /var/lib/apt/lists/* \
    && bash --version | head -1 && perl -v | sed -n 2p && ruby -v && echo 'puts [info patchlevel]' | tclsh \
    && lua -v && php -v | head -1 && gawk --version | head -1 && jq --version && sqlite3 --version && mlr --version
ENV LANG=C.UTF-8
USER 65534:65534
WORKDIR /tmp

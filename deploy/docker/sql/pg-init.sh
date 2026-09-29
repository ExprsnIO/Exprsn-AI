#!/bin/sh
# Creates the development HR database next to the application database and loads its user table.
set -eu
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE hr"
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d hr -f /seed/pg-hr.sql

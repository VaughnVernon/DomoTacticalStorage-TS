#!/bin/bash
# DomoTacticalStorage-TS Test Runner
# Runs tests with proper infrastructure setup

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default settings
RUN_POSTGRES=true
RUN_KURRENTDB=true
RUN_D1=true
KEEP_CONTAINERS=false

usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --postgres-only    Run only PostgreSQL tests"
    echo "  --kurrentdb-only   Run only KurrentDB tests"
    echo "  --d1-only          Run only D1 tests"
    echo "  --no-postgres      Skip PostgreSQL tests"
    echo "  --no-kurrentdb     Skip KurrentDB tests"
    echo "  --no-d1            Skip D1 tests"
    echo "  --keep             Keep containers running after tests"
    echo "  --help             Show this help message"
    exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --postgres-only)
            RUN_KURRENTDB=false
            RUN_D1=false
            shift
            ;;
        --kurrentdb-only)
            RUN_POSTGRES=false
            RUN_D1=false
            shift
            ;;
        --d1-only)
            RUN_POSTGRES=false
            RUN_KURRENTDB=false
            shift
            ;;
        --no-postgres)
            RUN_POSTGRES=false
            shift
            ;;
        --no-kurrentdb)
            RUN_KURRENTDB=false
            shift
            ;;
        --no-d1)
            RUN_D1=false
            shift
            ;;
        --keep)
            KEEP_CONTAINERS=true
            shift
            ;;
        --help)
            usage
            ;;
        *)
            echo "Unknown option: $1"
            usage
            ;;
    esac
done

echo -e "${BLUE}=== DomoTacticalStorage-TS Test Runner ===${NC}"
echo ""

cd "$PROJECT_DIR"

# Track test results
POSTGRES_RESULT=0
KURRENTDB_RESULT=0
D1_RESULT=0

cleanup() {
    if [ "$KEEP_CONTAINERS" = false ]; then
        echo -e "\n${YELLOW}Cleaning up containers...${NC}"
        docker compose down -v 2>/dev/null || true
    else
        echo -e "\n${YELLOW}Keeping containers running (use 'docker compose down' to stop)${NC}"
    fi
}

trap cleanup EXIT

# Start required infrastructure
start_infrastructure() {
    local services=""

    if [ "$RUN_POSTGRES" = true ]; then
        services="$services postgres"
    fi

    if [ "$RUN_KURRENTDB" = true ]; then
        services="$services kurrentdb"
    fi

    if [ -n "$services" ]; then
        echo -e "${YELLOW}Starting infrastructure:${NC} $services"
        docker compose up -d $services

        # Wait for services to be healthy
        if [ "$RUN_POSTGRES" = true ]; then
            echo -e "${YELLOW}Waiting for PostgreSQL...${NC}"
            for i in {1..30}; do
                if docker compose exec -T postgres pg_isready -U postgres > /dev/null 2>&1; then
                    echo -e "${GREEN}PostgreSQL is ready${NC}"
                    break
                fi
                sleep 1
            done
        fi

        if [ "$RUN_KURRENTDB" = true ]; then
            echo -e "${YELLOW}Waiting for KurrentDB...${NC}"
            for i in {1..30}; do
                if curl -s http://localhost:2113/health/live > /dev/null 2>&1; then
                    echo -e "${GREEN}KurrentDB is ready${NC}"
                    break
                fi
                sleep 1
            done
        fi
    fi
}

# Run PostgreSQL tests
run_postgres_tests() {
    if [ "$RUN_POSTGRES" = true ]; then
        echo -e "\n${BLUE}=== Running PostgreSQL Tests ===${NC}"

        export TEST_POSTGRES_URL="postgresql://postgres:postgres@localhost:5432/domo_test"

        if npm run test:postgres; then
            echo -e "${GREEN}PostgreSQL tests passed${NC}"
            POSTGRES_RESULT=0
        else
            echo -e "${RED}PostgreSQL tests failed${NC}"
            POSTGRES_RESULT=1
        fi
    fi
}

# Run KurrentDB tests
run_kurrentdb_tests() {
    if [ "$RUN_KURRENTDB" = true ]; then
        echo -e "\n${BLUE}=== Running KurrentDB Tests ===${NC}"

        export TEST_KURRENTDB_URL="kurrentdb://localhost:2113?tls=false"

        if npm run test:kurrentdb; then
            echo -e "${GREEN}KurrentDB tests passed${NC}"
            KURRENTDB_RESULT=0
        else
            echo -e "${RED}KurrentDB tests failed${NC}"
            KURRENTDB_RESULT=1
        fi
    fi
}

# Run D1 tests
run_d1_tests() {
    if [ "$RUN_D1" = true ]; then
        echo -e "\n${BLUE}=== Running D1 Tests ===${NC}"

        if npm run test:d1; then
            echo -e "${GREEN}D1 tests passed${NC}"
            D1_RESULT=0
        else
            echo -e "${RED}D1 tests failed${NC}"
            D1_RESULT=1
        fi
    fi
}

# Main execution
start_infrastructure
run_postgres_tests
run_kurrentdb_tests
run_d1_tests

# Summary
echo -e "\n${BLUE}=== Test Summary ===${NC}"

if [ "$RUN_POSTGRES" = true ]; then
    if [ $POSTGRES_RESULT -eq 0 ]; then
        echo -e "  PostgreSQL: ${GREEN}PASSED${NC}"
    else
        echo -e "  PostgreSQL: ${RED}FAILED${NC}"
    fi
fi

if [ "$RUN_KURRENTDB" = true ]; then
    if [ $KURRENTDB_RESULT -eq 0 ]; then
        echo -e "  KurrentDB:  ${GREEN}PASSED${NC}"
    else
        echo -e "  KurrentDB:  ${RED}FAILED${NC}"
    fi
fi

if [ "$RUN_D1" = true ]; then
    if [ $D1_RESULT -eq 0 ]; then
        echo -e "  D1:         ${GREEN}PASSED${NC}"
    else
        echo -e "  D1:         ${RED}FAILED${NC}"
    fi
fi

# Exit with failure if any tests failed
TOTAL_RESULT=$((POSTGRES_RESULT + KURRENTDB_RESULT + D1_RESULT))
exit $TOTAL_RESULT

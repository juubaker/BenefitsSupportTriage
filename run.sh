cd evals
source .venv/bin/activate
export AGENT_APP_URL=http://localhost:3001
export DATABASE_URL='postgresql://triage:triage@localhost:5433/triage'
python -m run --suite smoke

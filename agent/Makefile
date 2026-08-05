.PHONY: install train train-tiers serve test download-data clean

install:
	pip install -r requirements.txt

train:
	python -m training.train

# Shorter-threshold siblings of the live 180m model (see README "Delay
# tiers"). Sequential on purpose — each run holds the full CSV in memory.
train-tiers:
	python -m training.train --threshold-min 60 --out-dir artifacts/arr60
	python -m training.train --threshold-min 30 --out-dir artifacts/arr30

serve:
	python -m uvicorn app.main:app --port $${AGENT_PORT:-8000}

test:
	python -m pytest tests -q

download-data:
	python -m training.fetch_and_prepare --end 2026-05 --months 24

clean:
	rm -rf artifacts __pycache__ .pytest_cache
	find . -name __pycache__ -type d -exec rm -rf {} +

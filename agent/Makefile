.PHONY: install train serve test download-data clean

install:
	pip install -r requirements.txt

train:
	python -m training.train

serve:
	python -m uvicorn app.main:app --port $${AGENT_PORT:-8000}

test:
	python -m pytest tests -q

download-data:
	python -m training.fetch_and_prepare --end 2026-05 --months 24

clean:
	rm -rf artifacts __pycache__ .pytest_cache
	find . -name __pycache__ -type d -exec rm -rf {} +

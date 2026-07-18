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
	@echo "Manual download (Kaggle auth required):"
	@echo "  1. https://www.kaggle.com/competitions/flight-delays-fall-2018/data"
	@echo "  2. Save flight_delays_train.csv into agent/data/"
	@echo "  3. make train"

clean:
	rm -rf artifacts __pycache__ .pytest_cache
	find . -name __pycache__ -type d -exec rm -rf {} +

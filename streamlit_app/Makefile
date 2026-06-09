.PHONY: install run clean

install:
	pip install -r requirements.txt

run:
	streamlit run app.py

clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null; true

FROM python:3.12-slim
WORKDIR /app
COPY server.py case.py ./
COPY static ./static
ENV PORT=8666 PYTHONUNBUFFERED=1
EXPOSE 8666
USER nobody
HEALTHCHECK CMD python3 -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/healthz',timeout=3)"
CMD ["python3", "server.py"]

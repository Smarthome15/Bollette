# Base Debian multi-arch (aarch64/amd64): tutte le dipendenze hanno wheel
# precompilate, sul Raspberry non si compila nulla.
FROM python:3.12-slim-bookworm

# requirements.txt viene copiato nella cartella dell'add-on da deploy_addon.ps1
# (la fonte di verità resta quello nella radice del repo). Se cambia, alzare
# 'version' in config.yaml per far ricostruire l'immagine.
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD ["/run.sh"]

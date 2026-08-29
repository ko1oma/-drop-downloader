FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages --no-cache-dir -U yt-dlp gallery-dl instaloader curl-cffi
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN node patch-server.mjs
RUN node patch-instagram.mjs
ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000
CMD ["node","server.js"]

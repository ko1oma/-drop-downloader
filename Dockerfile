FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages --no-cache-dir -U yt-dlp tiktok_downloader gallery-dl instaloader
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000
CMD ["node","server.js"]

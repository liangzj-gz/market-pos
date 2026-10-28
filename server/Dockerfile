FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV NODE_ENV=production
EXPOSE 3000
# 以 root 跑：启动时修正 /data/files 卷属主（收款码上传目录）
CMD ["node", "src/index.js"]

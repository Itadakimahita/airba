
FROM node:18

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3000

# Указываем команду по умолчанию
CMD ["npx", "ts-node", "app.ts"]



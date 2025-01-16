
FROM node:latest

# Create app directory for the docker image
RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app/


# Bundle app source
COPY . /usr/src/app
RUN npm install

EXPOSE 3000

CMD ["node", "app.ts"]

FROM golang:1.27.3-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /gateway .
FROM alpine:3.23
RUN apk add --no-cache ca-certificates && addgroup -g 10001 gateway && adduser -D -u 10001 -G gateway gateway && mkdir /data && chown gateway:gateway /data
USER gateway
WORKDIR /data
COPY --from=build /gateway /gateway
EXPOSE 8080
ENTRYPOINT ["/gateway"]

FROM golang:1.25-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN apk add --no-cache git
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /iot-ota-server main.go

FROM alpine:3.18
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=build /iot-ota-server /app/iot-ota-server
COPY views /app/views
COPY static /app/static
EXPOSE 9999
ENTRYPOINT ["/app/iot-ota-server"]
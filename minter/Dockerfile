# Stage 1: Build the `ord` binary
FROM rust:1.81.0-bookworm as builder
WORKDIR /usr/src/ord
RUN git clone https://github.com/ordinals/ord.git . \
    && cargo build --bin ord --release

# Stage 2: Create the final image
FROM node:14-slim

# Force the use of bullseye repositories
RUN echo "deb http://deb.debian.org/debian bullseye main" > /etc/apt/sources.list
RUN echo "deb http://deb.debian.org/debian bullseye-updates main" >> /etc/apt/sources.list
RUN echo "deb http://deb.debian.org/debian-security bullseye-security main" >> /etc/apt/sources.list

# Install OpenSSL and other dependencies
RUN apt-get update && apt-get install -y \
    openssl \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy ord binary from the builder stage
COPY --from=builder /usr/src/ord/target/release/ord /usr/local/bin

# Ensure OpenSSL is in the library search path
ENV LD_LIBRARY_PATH=/usr/lib/ssl:/usr/local/lib:$LD_LIBRARY_PATH

# Set environment variables
ENV RUST_BACKTRACE=1
ENV RUST_LOG=info
ENV PATH /usr/local/bin:$PATH

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Ensure the data directory exists and copy the file
RUN mkdir -p /usr/src/app/data
COPY data/file.txt /usr/src/app/data/file.txt

# Expose the port the app runs on
EXPOSE 3001

# Start the application
CMD ["node", "mint.js", "myWallet", "/usr/src/app/data/file.txt"]
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Simple check that the Worker is running.
    if (request.method === "GET") {
      return new Response("Pill image service is running.");
    }

    // The App Inventor pill photo will be sent here.
    if (request.method === "POST" && url.pathname === "/crop-pill") {
      try {
        const imageBytes = await request.arrayBuffer();

        const info = await env.IMAGES.info(imageBytes);
        console.log("Pill photo dimensions:", info.width, info.height);

        if (imageBytes.byteLength === 0) {
          return new Response("No image received.", { status: 400 });
        }

        const result = await env.IMAGES
          .input(imageBytes)
          .transform({
            trim: {
              top: 0.38,
              right: 0.3,
              bottom: 0.38,
              left: 0.3
            }
          })
          .transform({
            width: 800,
            height: 800,
            fit: "contain"
          })
          .output({
            format: "image/jpeg",
            quality: 90
          });

        return result.response();
      } catch (error) {
        return new Response(
          "Could not process image: " + error.message,
          { status: 500 }
        );
      }
    }

    return new Response("Not found.", { status: 404 });
  }
};

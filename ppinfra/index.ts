import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";

// Generate a unique bucket name using stack name and random suffix
const generatedBucketName = pulumi.interpolate`static-website-${pulumi.getStack()}-${Math.random().toString(36).substring(2, 8)}`;

// Create an S3 bucket V2 with unique name
const bucket = new aws.s3.BucketV2("static-website-bucket", {
    bucket: generatedBucketName,
    tags: {
        "Project": "StaticWebsite",
        "ManagedBy": "Pulumi",
    },
});

// Configure bucket ownership controls
const ownershipControls = new aws.s3.BucketOwnershipControls("ownership-controls", {
    bucket: bucket.id,
    rule: {
        objectOwnership: "BucketOwnerPreferred",
    },
});

// Configure public access block for the bucket
const publicAccessBlock = new aws.s3.BucketPublicAccessBlock("public-access-block", {
    bucket: bucket.id,
    blockPublicAcls: false,
    blockPublicPolicy: false,
    ignorePublicAcls: false,
    restrictPublicBuckets: false,
});

// Configure the bucket for static website hosting
const website = new aws.s3.BucketWebsiteConfigurationV2("website-config", {
    bucket: bucket.id,
    indexDocument: {
        suffix: "index.html",
    },
    errorDocument: {
        key: "error.html",
    },
}, { dependsOn: [ownershipControls, publicAccessBlock] });

// Create a bucket policy to allow public read access
const bucketPolicy = new aws.s3.BucketPolicy("bucket-policy", {
    bucket: bucket.id,
    policy: bucket.arn.apply(arn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: "*",
            Action: ["s3:GetObject"],
            Resource: [`${arn}/*`],
        }],
    })),
}, { dependsOn: publicAccessBlock });

// Create an Origin Access Identity for CloudFront
const originAccessIdentity = new aws.cloudfront.OriginAccessIdentity("origin-access-identity", {
    comment: "OAI for static website",
});

// Create a CloudFront distribution
const distribution = new aws.cloudfront.Distribution("cdn-distribution", {
    enabled: true,
    aliases: [], // Add your custom domains here if needed
    origins: [{
        domainName: bucket.bucketRegionalDomainName,
        originId: bucket.arn,
        s3OriginConfig: {
            originAccessIdentity: originAccessIdentity.cloudfrontAccessIdentityPath,
        },
    }],
    defaultRootObject: "index.html",
    defaultCacheBehavior: {
        targetOriginId: bucket.arn,
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD", "OPTIONS"],
        cachedMethods: ["GET", "HEAD", "OPTIONS"],
        forwardedValues: {
            queryString: false,
            cookies: {
                forward: "none",
            },
        },
        minTtl: 0,
        defaultTtl: 3600,
        maxTtl: 86400,
    },
    priceClass: "PriceClass_100",
    restrictions: {
        geoRestriction: {
            restrictionType: "none",
        },
    },
    viewerCertificate: {
        cloudfrontDefaultCertificate: true,
    },
    customErrorResponses: [{
        errorCode: 404,
        responseCode: 404,
        responsePagePath: "/error.html",
    }],
    waitForDeployment: true,
}, { dependsOn: [bucketPolicy] });

// Create default website files if directory doesn't exist
const websiteDir = "./website";
try {
    if (!fs.existsSync(websiteDir)) {
        fs.mkdirSync(websiteDir);
        fs.writeFileSync(path.join(websiteDir, "index.html"), `
<!DOCTYPE html>
<html>
<head>
    <title>Welcome</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        h1 { color: #2d3748; }
    </style>
</head>
<body>
    <h1>Welcome to your static website!</h1>
    <p>This is a default index.html file.</p>
    <p>You can replace this with your own content.</p>
</body>
</html>
        `);
        fs.writeFileSync(path.join(websiteDir, "error.html"), `
<!DOCTYPE html>
<html>
<head>
    <title>Error</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        h1 { color: #e53e3e; }
    </style>
</head>
<body>
    <h1>404 - Page Not Found</h1>
    <p>The requested page could not be found.</p>
    <p><a href="/">Return to home page</a></p>
</body>
</html>
        `);
    }

    // Sync local folder content to S3
    const files = fs.readdirSync(websiteDir);
    const bucketObjects: aws.s3.BucketObject[] = [];
    for (const file of files) {
        const filePath = path.join(websiteDir, file);
        if (fs.statSync(filePath).isFile()) {
            const bucketObject = new aws.s3.BucketObject(file, {
                bucket: bucket.id,
                source: new pulumi.asset.FileAsset(filePath),
                contentType: getContentType(filePath),
                acl: "public-read",
            }, { dependsOn: bucketPolicy });
            bucketObjects.push(bucketObject);
        }
    }
} catch (error) {
    console.log(`Warning: Could not process website directory - ${error}`);
}

// Helper function to determine content type
function getContentType(filePath: string): string {
    const ext = path.extname(filePath);
    switch (ext.toLowerCase()) {
        case ".html": return "text/html";
        case ".css": return "text/css";
        case ".js": return "application/javascript";
        case ".png": return "image/png";
        case ".jpg": case ".jpeg": return "image/jpeg";
        case ".gif": return "image/gif";
        case ".svg": return "image/svg+xml";
        case ".json": return "application/json";
        case ".txt": return "text/plain";
        case ".ico": return "image/x-icon";
        case ".webp": return "image/webp";
        case ".woff": return "font/woff";
        case ".woff2": return "font/woff2";
        default: return "binary/octet-stream";
    }
}

// Export the requested values
export const cdnHostname = pulumi.interpolate`CDN Hostname: ${distribution.domainName}`;
export const cdnUrl = pulumi.interpolate`CDN URL: https://${distribution.domainName}`;
export const originHostname = pulumi.interpolate`Origin Hostname: ${bucket.bucketRegionalDomainName}`;
export const originUrl = pulumi.interpolate`Origin URL: http://${bucket.bucket}.s3-website-${aws.config.region}.amazonaws.com`;
export const bucketName = bucket.bucket;
export const distributionId = distribution.id;

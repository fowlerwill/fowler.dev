import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class FowlerDevStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

  const domainName = 'fowler.dev';
  // Avoid dots in S3 bucket names used as CloudFront S3 origins over HTTPS
  const sanitizedDomain = domainName.replace(/\./g, '-');
  const accountId = cdk.Stack.of(this).account;
  const bucketName = `${sanitizedDomain}-${accountId}-hugo-site`;

    // S3 bucket to host the Hugo site
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: bucketName,
      // No website configuration: use S3 REST endpoint with CloudFront OAC
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Origin Access Control (OAC) for CloudFront to access S3 (replaces legacy OAI)
    const oac = new cloudfront.CfnOriginAccessControl(this, 'OAC', {
      originAccessControlConfig: {
        name: `${domainName}-oac`,
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
        description: `OAC for ${domainName}`,
      },
    });

    // Route53 hosted zone (assumes you already have this)
    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: domainName,
    });

    // SSL Certificate
    const certificate = new certificatemanager.DnsValidatedCertificate(this, 'SiteCertificate', {
      domainName: domainName,
      hostedZone: hostedZone,
      region: 'us-east-1', // CloudFront certificates must be in us-east-1
      subjectAlternativeNames: [`www.${domainName}`],
    });

    // CloudFront Function: rewrite pretty URLs to /index.html under directories
    const urlRewriteFn = new cloudfront.Function(this, 'UrlRewriteFn', {
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event) {\n" +
          "  var request = event.request;\n" +
          "  var uri = request.uri;\n" +
          "  if (uri && uri.length > 1) {\n" +
          "    if (uri.charAt(uri.length - 1) === '/') {\n" +
          "      request.uri = uri + 'index.html';\n" +
          "    } else if (uri.indexOf('.') === -1) {\n" +
          "      request.uri = uri + '/index.html';\n" +
          "    }\n" +
          "  }\n" +
          "  return request;\n" +
        "}"
      ),
    });

    // CloudFront distribution
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          {
            function: urlRewriteFn,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      domainNames: [domainName, `www.${domainName}`],
      certificate: certificate,
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: cdk.Duration.minutes(30),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: cdk.Duration.minutes(30),
        },
      ],
    });

    // Attach the OAC to the S3 origin in the underlying CloudFront distribution
  const cfnDistribution = distribution.node.defaultChild as cloudfront.CfnDistribution;
  cfnDistribution.addPropertyOverride('DistributionConfig.Origins.0.OriginAccessControlId', oac.attrId);
  // Ensure CloudFront treats the origin as an S3 origin with OAC (no OAI)
  cfnDistribution.addPropertyOverride('DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity', '');
  cfnDistribution.addPropertyDeletionOverride('DistributionConfig.Origins.0.CustomOriginConfig');

    // Update S3 bucket policy to allow CloudFront (via OAC) to read objects
    siteBucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [siteBucket.arnForObjects('*')],
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      conditions: {
        StringEquals: {
          'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
        },
      },
    }));

    // Route53 records
    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution)),
    });

    new route53.ARecord(this, 'WwwAliasRecord', {
      zone: hostedZone,
      recordName: 'www',
      target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution)),
    });

    // IAM user for GitHub Actions deployment
    const deployUser = new iam.User(this, 'GitHubActionsUser', {
      userName: `${domainName}-github-actions`,
    });

    const deployPolicy = new iam.Policy(this, 'DeployPolicy', {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            's3:PutObject',
            's3:PutObjectAcl',
            's3:GetObject',
            's3:DeleteObject',
            's3:ListBucket',
          ],
          resources: [
            siteBucket.bucketArn,
            `${siteBucket.bucketArn}/*`,
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'cloudfront:CreateInvalidation',
          ],
          resources: [
            `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
          ],
        }),
      ],
    });

    deployUser.attachInlinePolicy(deployPolicy);

    // Outputs
    new cdk.CfnOutput(this, 'BucketName', {
      value: siteBucket.bucketName,
      description: 'Name of the S3 bucket',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront Distribution ID',
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront Distribution Domain Name',
    });

    new cdk.CfnOutput(this, 'DeployUserName', {
      value: deployUser.userName,
      description: 'IAM User for GitHub Actions',
    });
  }
}
